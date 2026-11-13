import clsx from "clsx";
import { CalendarDays, Hourglass, LayoutDashboard, Puzzle, Settings as SettingsIcon, ShieldAlert, ShieldBan, Snowflake, Tags, Timer } from "lucide-react";
import { useEffect, useState } from "react";
import { BrowserWarning } from "./components/BrowserWarning";
import { ExtensionPrompt } from "./components/ExtensionPrompt";
import { Toasts, usePref } from "./components/ui";
import { api, isTauri } from "./lib/api";
import { useStore } from "./lib/store";
import { CategoriesPage } from "./pages/Categories";
import { Dashboard } from "./pages/Dashboard";
import { FocusPage } from "./pages/Focus";
import { FreezePage } from "./pages/Freeze";
import { LimitsPage } from "./pages/Limits";
import { ListsPage } from "./pages/Lists";
import { SchedulePage } from "./pages/Schedule";
import { SettingsPage } from "./pages/Settings";
import { t } from "./lib/i18n";

export type Page = "today" | "lists" | "categories" | "schedule" | "limits" | "focus" | "freeze" | "settings";

const NAV: { id: Page; label: string; icon: typeof Timer }[] = [
  { id: "today", label: t("Today"), icon: LayoutDashboard },
  { id: "lists", label: t("Block lists"), icon: ShieldBan },
  { id: "categories", label: t("Categories"), icon: Tags },
  { id: "schedule", label: t("Schedule"), icon: CalendarDays },
  { id: "limits", label: t("Daily limits"), icon: Hourglass },
  { id: "focus", label: t("Focus timer"), icon: Timer },
  { id: "freeze", label: t("Freeze PC"), icon: Snowflake },
  { id: "settings", label: t("Settings"), icon: SettingsIcon },
];

/** Applies the chosen theme ("system" follows Windows). The freeze screen always stays dark. */
function useTheme() {
  const [theme] = usePref<"dark" | "light" | "system">("theme", "dark");
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const light = theme === "light" || (theme === "system" && media.matches);
      document.documentElement.dataset.theme = light ? "light" : "dark";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}

export default function App() {
  const { snap, run } = useStore();
  useTheme();
  const [page, setPage] = useState<Page>(() => (localStorage.getItem("ob-page") as Page) || "today");
  useEffect(() => localStorage.setItem("ob-page", page), [page]);

  if (!snap) {
    return (
      <div className="grid h-full place-items-center text-muted">
        <img src="/logo.svg" className="size-12 animate-pulse" alt="" />
      </div>
    );
  }

  const { status } = snap;
  const blocking = status.active.length > 0;

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-panel/60 px-3 py-5">
        <div className="mb-8 flex items-center gap-2.5 px-2">
          <img src="/logo.svg" className="size-8" alt="" />
          <span className="font-display text-lg font-semibold tracking-tight">
            Open<span className="gradient-text">Blocker</span>
          </span>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setPage(id)}
              className={clsx(
                "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition",
                page === id ? "bg-elevated text-fg shadow-sm ring-1 ring-line" : "text-muted hover:bg-elevated/50 hover:text-fg",
              )}
            >
              <Icon size={18} className={clsx(page === id ? "text-accent" : "text-faint group-hover:text-muted")} />
              {label}
              {id === "focus" && snap.state.pomodoro && <span className="ml-auto size-2 rounded-full bg-accent-2" />}
              {id === "freeze" && snap.state.freeze && <span className="ml-auto size-2 rounded-full bg-cyan-300" />}
            </button>
          ))}
        </nav>
        <div className="mt-auto rounded-xl border border-line bg-card p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className={clsx("size-2.5 rounded-full", blocking ? "pulse-dot bg-good" : "bg-faint")} />
            {blocking ? t("Blocking active") : t("Nothing blocked")}
          </div>
          <p className="mt-1 text-xs text-muted">
            {blocking ? t("{sites} sites · {apps} apps", { sites: status.blockedSites, apps: status.blockedApps }) : t("Start a block or set a schedule.")}
          </p>
        </div>
      </aside>

      <main className="relative min-w-0 flex-1 overflow-y-auto">
        {status.hostsError && (
          <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-8 py-2.5 text-sm text-amber-200 backdrop-blur">
            <ShieldAlert size={18} className="shrink-0" />
            <span className="flex-1">{status.hostsError} {t("App blocking still works.")}</span>
            {isTauri && !status.service && (
              <button className="btn-ghost py-1" onClick={() => run(async () => (await api.relaunchAsAdmin(), api.snapshot()))}>
                {t("Restart as administrator")}
              </button>
            )}
          </div>
        )}
        {status.extensionFeatures && status.extension.length === 0 && (
          <div className="sticky top-0 z-20 flex items-center gap-3 border-b border-cyan-500/30 bg-cyan-500/10 px-8 py-2.5 text-sm text-cyan-100 backdrop-blur">
            <Puzzle size={18} className="shrink-0" />
            <span className="flex-1">
              {snap.state.settings.extensionFallback === "strict"
                ? t("Some of this block needs the browser extension. Until it's installed, those sites are blocked completely.")
                : t("Some of this block needs the browser extension. Until it's installed, those parts aren't blocked.")}
            </span>
            <button className="btn-ghost py-1" onClick={() => setPage("settings")}>
              {t("Set up extension")}
            </button>
          </div>
        )}
        <div key={page} className="animate-fade-up mx-auto max-w-6xl px-8 py-8">
          {page === "today" && <Dashboard go={setPage} />}
          {page === "lists" && <ListsPage go={setPage} />}
          {page === "categories" && <CategoriesPage go={setPage} />}
          {page === "schedule" && <SchedulePage />}
          {page === "limits" && <LimitsPage go={setPage} />}
          {page === "focus" && <FocusPage />}
          {page === "freeze" && <FreezePage />}
          {page === "settings" && <SettingsPage />}
        </div>
      </main>
      <ExtensionPrompt go={setPage} />
      <BrowserWarning />
      <Toasts />
    </div>
  );
}
