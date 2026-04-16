import Link from "next/link";

const envRows = [
  ["NOTION_TOKEN", "Internal integration secret"],
  ["NOTION_DATABASE_ID", "Production database id"],
  [
    "NOTION_WEBHOOK_VERIFICATION_TOKEN",
    "Optional; verification_token from Notion webhook setup (validates signatures)",
  ],
  ["TELEGRAM_BOT_TOKEN", "From BotFather"],
  ["NEXT_PUBLIC_APP_URL", "Public site URL for webhooks"],
  ["TELEGRAM_WEBHOOK_SECRET", "Optional; must match Telegram secret header"],
  [
    "NOTION_PROP_TELEGRAM_USER_ID",
    "Telegram id column on Production (default: \"Telegram user id\"). Source of truth for /mine.",
  ],
  [
    "TELEGRAM_USER_ASSIGNEE_MAP",
    "Optional; JSON Telegram id → assignee name (fallback for people who haven't run /link)",
  ],
  [
    "NOTION_TEAM_LINK_DATABASE_ID",
    "Optional; directory DB mirrored on /link (for ops lookups, not required for /mine)",
  ],
  ["ADMIN_SETUP_SECRET", "Protects the set-webhook + digest helper routes"],
  ["CRON_SECRET", "Set by Vercel Cron automatically; also usable for manual runs"],
  [
    "TELEGRAM_OPS_USER_IDS",
    "Optional; JSON array of Telegram numeric ids allowed to run /ops",
  ],
  [
    "TELEGRAM_SOCIAL_MANAGER_IDS",
    "Optional; JSON array notified when someone taps \"Send to client\"",
  ],
  [
    "TELEGRAM_DIGEST_TZ / _HOUR",
    "Digest localtime gate (default Europe/Rome 08:00, DST-safe)",
  ],
];

export default function Home() {
  return (
    <div className="relative min-h-full overflow-hidden bg-[#07080b] text-zinc-100">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(1200px_circle_at_20%_-10%,rgba(99,102,241,0.35),transparent_55%),radial-gradient(900px_circle_at_90%_10%,rgba(236,72,153,0.22),transparent_50%),radial-gradient(800px_circle_at_50%_120%,rgba(56,189,248,0.18),transparent_55%)]"
      />
      <div className="relative mx-auto flex min-h-full w-full max-w-5xl flex-col gap-16 px-6 py-16 sm:px-10 sm:py-20">
        <header className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-4">
            <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium tracking-wide text-zinc-200/90 ring-1 ring-white/10 backdrop-blur">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.9)]" />
              Telegram × Notion · 2026
            </p>
            <h1 className="max-w-2xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
              Anvance Production task desk
            </h1>
            <p className="max-w-xl text-pretty text-base leading-relaxed text-zinc-400 sm:text-lg">
              A focused ops copilot: ask in plain language, tap glassy inline
              actions, and pull live tasks from your Notion Production database.
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:items-end">
            <Link
              className="inline-flex h-11 items-center justify-center rounded-xl bg-white px-5 text-sm font-semibold text-zinc-950 shadow-[0_20px_60px_rgba(255,255,255,0.12)] transition hover:bg-zinc-100"
              href="https://t.me/BotFather"
              target="_blank"
              rel="noreferrer"
            >
              Open BotFather
            </Link>
            <p className="max-w-xs text-right text-xs leading-relaxed text-zinc-500">
              Ship the webhook to{" "}
              <code className="rounded-md bg-white/5 px-1.5 py-0.5 text-[11px] text-zinc-200">
                /api/telegram/webhook
              </code>
            </p>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset] backdrop-blur">
            <h2 className="text-sm font-semibold text-white">Operator flow</h2>
            <ul className="mt-4 space-y-3 text-sm text-zinc-300">
              <li className="flex gap-3">
                <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 text-xs font-semibold text-indigo-200 ring-1 ring-indigo-400/30">
                  1
                </span>
                <span>
                  Connect Notion: create an integration and invite it to your
                  Production database.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-fuchsia-500/15 text-xs font-semibold text-fuchsia-200 ring-1 ring-fuchsia-400/30">
                  2
                </span>
                <span>
                  Paste secrets into{" "}
                  <code className="rounded-md bg-black/40 px-1.5 py-0.5 text-[11px]">
                    .env.local
                  </code>{" "}
                  (see <code className="text-[11px]">.env.example</code>).
                </span>
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-xs font-semibold text-sky-200 ring-1 ring-sky-400/30">
                  3
                </span>
                <span>
                  Call the protected set-webhook route once your app is public.
                </span>
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-xs font-semibold text-emerald-200 ring-1 ring-emerald-400/30">
                  4
                </span>
                <span>
                  Team self-onboards: each teammate runs{" "}
                  <code className="text-[11px]">/link Your Name</code> once.
                  The bot stamps their Telegram id on their Production rows, so{" "}
                  <code className="text-[11px]">/mine</code>, digests, and push
                  notifications all work without editing env JSON.
                </span>
              </li>
            </ul>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset] backdrop-blur lg:col-span-2">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-sm font-semibold text-white">Environment</h2>
              <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-200 ring-1 ring-emerald-300/20">
                copy-ready
              </span>
            </div>
            <div className="mt-4 overflow-hidden rounded-xl border border-white/10 bg-black/30">
              <table className="w-full text-left text-xs sm:text-sm">
                <thead className="bg-white/[0.03] text-[11px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-4 py-3 font-medium">Key</th>
                    <th className="px-4 py-3 font-medium">Purpose</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-zinc-300">
                  {envRows.map(([key, desc]) => (
                    <tr key={key} className="align-top">
                      <td className="px-4 py-3 font-mono text-[11px] text-indigo-100 sm:text-xs">
                        {key}
                      </td>
                      <td className="px-4 py-3 text-zinc-400">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs leading-relaxed text-zinc-500">
              After deploy:{" "}
              <code className="rounded-md bg-black/40 px-1.5 py-0.5 text-[11px] text-zinc-200">
                GET /api/telegram/set-webhook?secret=ADMIN_SETUP_SECRET
              </code>
              {" · "}
              <code className="rounded-md bg-black/40 px-1.5 py-0.5 text-[11px] text-zinc-200">
                GET /api/telegram/status?secret=ADMIN_SETUP_SECRET
              </code>{" "}
              (webhook + env diagnostics)
              . Notion webhooks:{" "}
              <code className="rounded-md bg-black/40 px-1.5 py-0.5 text-[11px] text-zinc-200">
                /api/notion/webhook
              </code>{" "}
              — after Resend,{" "}
              <code className="text-[11px]">
                GET …/api/notion/webhook?secret=ADMIN_SETUP_SECRET
              </code>{" "}
              or Vercel logs; then optional{" "}
              <code className="text-[11px]">NOTION_WEBHOOK_VERIFICATION_TOKEN</code>.
            </p>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.07] to-white/[0.02] p-6">
            <h2 className="text-sm font-semibold text-white">Telegram UX</h2>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              Inline keyboards for Today, This week, My queue, and Team board,
              plus <b>Link account</b> /{" "}
              <code className="text-[11px] text-zinc-200">/link</code> for
              self-service My queue setup. Natural prompts like{" "}
              <span className="text-zinc-200">
                “what are my tasks today”
              </span>{" "}
              route to the same engine as slash commands.
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              {[
                "/today",
                "/week",
                "/mine",
                "/overdue",
                "/board",
                "/find",
                "/new",
                "/link",
                "/ops",
                "/help",
              ].map((cmd) => (
                <div
                  key={cmd}
                  className="rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-xs text-zinc-200"
                >
                  {cmd}
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs leading-relaxed text-zinc-500">
              Each task card has inline actions — <b>Open in Notion</b>,{" "}
              <b>Review</b>, <b>✈️ Send to client</b> (flips Client approval ={" "}
              <i>Sent</i> and DMs social managers), <b>Done</b>, <b>Snooze 1d</b>.
              Morning digest DMs every linked teammate at <b>08:00 Europe/Rome</b>{" "}
              (auto-adjusts for CET/CEST). Notion webhooks DM the assignee on
              new tasks and hot status changes.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6">
            <h2 className="text-sm font-semibold text-white">Notion fields</h2>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              Defaults follow your CSV export: Name, Assignee, Due date, Shoot
              / live date, Status, Priority, Deliverable, Client, Service line,
              Reviewer, <b>Telegram user id</b>. Rename in Notion? Mirror with{" "}
              <code className="rounded-md bg-black/40 px-1.5 py-0.5 text-[11px]">
                NOTION_PROP_*
              </code>{" "}
              variables.
            </p>
            <div className="mt-5 rounded-xl border border-dashed border-white/15 bg-black/25 p-4 text-xs text-zinc-400">
              <b>My queue</b> = Production rows where{" "}
              <code className="text-[11px]">Telegram user id</code> equals the
              caller. <b>/link</b> writes that column on your open rows so
              onboarding is self-service. Inline actions (<b>Review</b>,{" "}
              <b>Done</b>, <b>Snooze</b>) write back to Notion immediately.
            </div>
          </div>
        </section>

        <footer className="flex flex-col gap-2 border-t border-white/10 pt-8 text-xs text-zinc-500 sm:flex-row sm:items-center sm:justify-between">
          <p>Anvance Production · internal operator console</p>
          <p className="text-zinc-600">
            Built with Next.js App Router + Tailwind v4
          </p>
        </footer>
      </div>
    </div>
  );
}
