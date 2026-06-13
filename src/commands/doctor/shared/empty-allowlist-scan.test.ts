// Empty allowlist scan tests cover doctor detection of unconfigured sender allowlists.
import { describe, expect, it, vi } from "vitest";
import { scanEmptyAllowlistPolicyWarnings } from "./empty-allowlist-scan.js";

vi.mock("../channel-capabilities.js", () => ({
  getDoctorChannelCapabilities: (channelName?: string) => ({
    dmAllowFromMode: "topOnly",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: channelName !== "imessage",
    warnOnEmptyGroupSenderAllowlist: channelName !== "discord",
  }),
}));

vi.mock("./channel-doctor.js", () => ({
  shouldSkipChannelDoctorDefaultEmptyGroupAllowlistWarning: () => false,
}));

describe("doctor empty allowlist policy scan", () => {
  it("scans top-level and account-scoped channel warnings", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          signal: {
            dmPolicy: "allowlist",
            accounts: {
              work: { dmPolicy: "allowlist" },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toEqual([
      '- channels.signal.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to channels.signal.allowFrom, or run "openclaw doctor --fix" to auto-migrate from pairing store when entries exist.',
      '- channels.signal.accounts.work.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to channels.signal.accounts.work.allowFrom, or run "openclaw doctor --fix" to auto-migrate from pairing store when entries exist.',
    ]);
  });

  it("allows provider-specific extra warnings without importing providers", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
          },
        },
      },
      {
        doctorFixCommand: "openclaw doctor --fix",
        extraWarningsForAccount: ({ channelName, prefix }) =>
          channelName === "telegram" ? [`extra:${prefix}`] : [],
      },
    );

    expect(warnings).toStrictEqual([
      '- channels.telegram.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to channels.telegram.groupAllowFrom or channels.telegram.allowFrom, or set groupPolicy to "open".',
      "extra:channels.telegram",
    ]);
  });

  it("skips parent-level empty-group-allowlist warning when every account has groupAllowFrom", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            allowFrom: ["user1"],
            accounts: {
              account1: {
                groupAllowFrom: ["group-user-a"],
              },
              account2: {
                groupAllowFrom: ["group-user-b"],
              },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    // No group-allowlist warning because accounts supply their own lists.
    expect(warnings).toEqual([]);
  });

  it("still warns on parent-level empty-group-allowlist when no accounts exist", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toEqual([
      '- channels.telegram.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to channels.telegram.groupAllowFrom or channels.telegram.allowFrom, or set groupPolicy to "open".',
    ]);
  });

  it("warns on parent-level empty-group-allowlist when some accounts lack groupAllowFrom", () => {
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            accounts: {
              account1: {
                groupAllowFrom: ["group-user-a"],
              },
              account2: {
                groupPolicy: "allowlist",
                // No groupAllowFrom and no parent allowFrom to fall back on.
              },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    // Parent warning is still emitted because not all accounts have groupAllowFrom.
    const groupWarnings = warnings.filter((w) => w.includes("group messages"));
    expect(groupWarnings.length).toBeGreaterThanOrEqual(1);
    expect(groupWarnings.some((w) => w.startsWith("- channels.telegram.groupPolicy"))).toBe(true);
  });

  it("suppresses parent warning when every account uses numeric sender IDs in groupAllowFrom", () => {
    // Numeric sender IDs are valid on channels like Telegram/WhatsApp and must
    // count toward "every account has a group allowlist" — matching runtime
    // normalization semantics (normalizeStringEntries coerces numbers).
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            accounts: {
              account1: {
                groupAllowFrom: [1005001234],
              },
              account2: {
                groupAllowFrom: ["  ", 2006007890],
              },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toEqual([]);
  });

  it("suppresses parent warning when every account satisfies via allowFrom fallback", () => {
    // On channels where groupAllowFrom falls back to allowFrom at runtime,
    // a populated account-level allowFrom must also satisfy the policy.
    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            accounts: {
              account1: {
                allowFrom: ["sender-a"],
              },
              account2: {
                allowFrom: ["sender-b"],
              },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix" },
    );

    expect(warnings).toEqual([]);
  });

  it("suppresses channel-specific extra warnings on parent scope when all accounts have groupAllowFrom", () => {
    // Even when a channel plugin supplies its own extraWarningsForAccount hook
    // (e.g. Telegram), the parent-scope suppression must extend to those
    // plugin warnings so the false-positive advisory is fully silenced.
    const extraWarningsForAccount = vi.fn(({ prefix }) => [`extra:${prefix}`]);

    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            accounts: {
              account1: {
                groupAllowFrom: ["group-user-a"],
              },
              account2: {
                groupAllowFrom: ["group-user-b"],
              },
            },
          },
        },
      },
      {
        doctorFixCommand: "openclaw doctor --fix",
        extraWarningsForAccount,
      },
    );

    // Parent-scope extra warning is suppressed; only account-scope fire.
    const parentOnlyExtra = warnings.filter(
      (w) => w.startsWith("extra:") && !w.includes(".accounts."),
    );
    expect(parentOnlyExtra).toEqual([]);
    // Account-scope extra warnings still fire.
    expect(warnings).toEqual(
      expect.arrayContaining([
        "extra:channels.telegram.accounts.account1",
        "extra:channels.telegram.accounts.account2",
      ]),
    );
    // Account-scope hooks are still invoked.
    const accountPrefixes = extraWarningsForAccount.mock.calls.map(([opts]) => opts?.prefix);
    expect(accountPrefixes).toEqual(
      expect.arrayContaining([
        "channels.telegram.accounts.account1",
        "channels.telegram.accounts.account2",
      ]),
    );
    // Parent scope hook is never called.
    expect(extraWarningsForAccount).not.toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "channels.telegram" }),
    );
  });

  it("skips disabled channel and account entries", () => {
    const extraWarningsForAccount = vi.fn(({ prefix }) => [`extra:${prefix}`]);

    const warnings = scanEmptyAllowlistPolicyWarnings(
      {
        channels: {
          telegram: {
            enabled: false,
            dmPolicy: "allowlist",
            accounts: {
              default: { dmPolicy: "allowlist" },
            },
          },
          signal: {
            accounts: {
              disabled: { enabled: false, dmPolicy: "allowlist" },
            },
          },
        },
      },
      { doctorFixCommand: "openclaw doctor --fix", extraWarningsForAccount },
    );

    expect(warnings).toEqual(["extra:channels.signal"]);
    expect(extraWarningsForAccount).toHaveBeenCalledTimes(1);
    const [warningOptions] = extraWarningsForAccount.mock.calls[0] ?? [];
    expect(warningOptions?.prefix).toBe("channels.signal");
  });
});
