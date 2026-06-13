// Doctor scanner for empty allowlist policies across configured channels and accounts.
import type { ChannelDoctorEmptyAllowlistAccountContext } from "../../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DoctorAccountRecord, DoctorAllowFromList } from "../types.js";
import { hasAllowFromEntries } from "./allowlist.js";
import { collectEmptyAllowlistPolicyWarningsForAccount } from "./empty-allowlist-policy.js";
import { asObjectRecord } from "./object.js";

type ScanEmptyAllowlistPolicyWarningsParams = {
  doctorFixCommand: string;
  extraWarningsForAccount?: (params: ChannelDoctorEmptyAllowlistAccountContext) => string[];
  shouldSkipDefaultEmptyGroupAllowlistWarning?: (
    params: ChannelDoctorEmptyAllowlistAccountContext,
  ) => boolean;
};

function isDisabledRecord(value: unknown): boolean {
  return (
    Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
    (value as { enabled?: unknown }).enabled === false
  );
}

/** Scan all configured channels/accounts for empty allowlist policy warnings. */
export function scanEmptyAllowlistPolicyWarnings(
  cfg: OpenClawConfig,
  params: ScanEmptyAllowlistPolicyWarningsParams,
): string[] {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object") {
    return [];
  }

  const warnings: string[] = [];

  const checkAccount = (
    account: DoctorAccountRecord,
    prefix: string,
    channelName: string,
    parent?: DoctorAccountRecord,
    opts?: { allAccountsHaveGroupAllowlist?: boolean },
  ) => {
    const accountDm = asObjectRecord(account.dm);
    const parentDm = asObjectRecord(parent?.dm);
    const dmPolicy =
      (account.dmPolicy as string | undefined) ??
      (accountDm?.policy as string | undefined) ??
      (parent?.dmPolicy as string | undefined) ??
      (parentDm?.policy as string | undefined) ??
      undefined;
    const effectiveAllowFrom =
      (account.allowFrom as DoctorAllowFromList | undefined) ??
      (parent?.allowFrom as DoctorAllowFromList | undefined) ??
      (accountDm?.allowFrom as DoctorAllowFromList | undefined) ??
      (parentDm?.allowFrom as DoctorAllowFromList | undefined) ??
      undefined;

    warnings.push(
      ...collectEmptyAllowlistPolicyWarningsForAccount({
        account,
        channelName,
        cfg,
        doctorFixCommand: params.doctorFixCommand,
        parent,
        prefix,
        shouldSkipDefaultEmptyGroupAllowlistWarning:
          params.shouldSkipDefaultEmptyGroupAllowlistWarning,
        allAccountsHaveGroupAllowlist: opts?.allAccountsHaveGroupAllowlist,
      }),
    );
    if (params.extraWarningsForAccount) {
      // When the parent-level default warning is suppressed because every
      // enabled child account supplies its own effective group allowlist,
      // also suppress channel-specific extra warnings for the parent scope —
      // otherwise a plugin (e.g. Telegram) could re-introduce a noisy
      // parent-level advisory that the shared scan just decided to skip.
      const isParentScope = !parent;
      const skipExtraWarningsForParent = Boolean(
        isParentScope && opts?.allAccountsHaveGroupAllowlist,
      );
      if (!skipExtraWarningsForParent) {
        warnings.push(
          ...params.extraWarningsForAccount({
            account,
            channelName,
            dmPolicy,
            effectiveAllowFrom,
            parent,
            prefix,
          }),
        );
      }
    }
  };

  for (const [channelName, channelConfig] of Object.entries(
    channels as Record<string, DoctorAccountRecord>,
  )) {
    if (!channelConfig || typeof channelConfig !== "object") {
      continue;
    }
    if (isDisabledRecord(channelConfig)) {
      continue;
    }
    const accounts = asObjectRecord(channelConfig.accounts);
    const enabledAccounts: Array<{
      id: string;
      account: DoctorAccountRecord;
    }> = [];
    if (accounts) {
      for (const [accountId, account] of Object.entries(accounts)) {
        if (!account || typeof account !== "object") {
          continue;
        }
        if (isDisabledRecord(account)) {
          continue;
        }
        enabledAccounts.push({ id: accountId, account: account as DoctorAccountRecord });
      }
    }

    // When every enabled account supplies its own effective non-empty group
    // allowlist (groupAllowFrom, or allowFrom where the channel falls back to
    // it), the top-level parent record is a pure fallback — skip the
    // parent-level empty-group-allowlist warning to avoid a false-positive
    // doctor advisory. Use the same `hasAllowFromEntries` predicate as the
    // warning/runtime helpers so numeric sender IDs and other normalized
    // entries are counted.
    const allAccountsHaveGroupAllowlist =
      enabledAccounts.length > 0 &&
      enabledAccounts.every(({ account }) => {
        const accountGroupAllowFrom = account.groupAllowFrom as DoctorAllowFromList | undefined;
        if (hasAllowFromEntries(accountGroupAllowFrom)) {
          return true;
        }
        // Channels that fall back from groupAllowFrom -> allowFrom at runtime
        // also satisfy the policy when allowFrom is populated.
        const accountAllowFrom = account.allowFrom as DoctorAllowFromList | undefined;
        return hasAllowFromEntries(accountAllowFrom);
      });

    checkAccount(channelConfig, `channels.${channelName}`, channelName, undefined, {
      allAccountsHaveGroupAllowlist,
    });

    for (const { id: accountId, account } of enabledAccounts) {
      checkAccount(
        account,
        `channels.${channelName}.accounts.${accountId}`,
        channelName,
        channelConfig,
      );
    }
  }

  return warnings;
}
