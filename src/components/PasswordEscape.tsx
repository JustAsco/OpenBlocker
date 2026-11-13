import { KeyRound } from "lucide-react";
import { useState } from "react";
import { t } from "../lib/i18n";
import { useStore } from "../lib/store";
import { PasswordDialog } from "./PasswordCard";
import { Toggle } from "./ui";

/**
 * "The unlock password can end it early", shown under a lock toggle. Turning
 * it on without a password asks to set one first.
 */
export function PasswordEscape({ checked, onChange, what }: { checked: boolean; onChange: (v: boolean) => void; what: string }) {
  const { snap } = useStore();
  const isSet = !!snap?.status.passwordSet;
  const [setting, setSetting] = useState(false);
  return (
    <>
      <Toggle
        label={
          <>
            <KeyRound size={14} className="text-accent-2" /> {t("Password can end it early")}
          </>
        }
        hint={isSet ? t("Whoever knows the unlock password can stop {what} before it ends.", { what }) : t("You'll be asked to set an unlock password first.")}
        checked={isSet && checked}
        onChange={(v) => (v && !isSet ? setSetting(true) : onChange(v))}
      />
      {setting && <PasswordDialog mode="set" onClose={() => setSetting(false)} onDone={() => onChange(true)} />}
    </>
  );
}
