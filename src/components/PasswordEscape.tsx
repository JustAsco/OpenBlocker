import { KeyRound } from "lucide-react";
import { useStore } from "../lib/store";
import { Toggle } from "./ui";
import { t } from "../lib/i18n";

/**
 * "The unlock password can end it early", shown under a lock toggle. Only
 * available once a password is set (Settings → Unlock password).
 */
export function PasswordEscape({ checked, onChange, what }: { checked: boolean; onChange: (v: boolean) => void; what: string }) {
  const { snap } = useStore();
  const isSet = !!snap?.status.passwordSet;
  return (
    <Toggle
      label={
        <>
          <KeyRound size={14} className="text-accent-2" /> {t("Password can end it early")}
        </>
      }
      hint={isSet ? t("Whoever knows the unlock password can stop {what} before it ends.", { what }) : t("Set an unlock password in Settings first.")}
      checked={isSet && checked}
      disabled={!isSet}
      onChange={onChange}
    />
  );
}
