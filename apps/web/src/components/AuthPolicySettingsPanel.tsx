/**
 * Authentication policy admin editor — mounted inside `OperationsPage`.
 *
 * Three controls written to `POST /org/config`:
 *
 *   - `auth.allowedEmailDomains` (CSV, empty = no restriction)
 *   - `auth.mfaRequired` (boolean, marker only — provider enforces)
 *   - `auth.sessionTtlSeconds` (range 300..86400)
 *
 * Admin-only. Calls `bumpPlatformVersion()` after a successful save so
 * any panel that reads org config refetches.
 *
 * Used by `OperationsPage.tsx`.
 */

import React, { useEffect, useState } from "react";
import { CheckCircle2, ShieldCheck, Save } from "lucide-react";
import { api } from "../api";
import { useWorkflowStore } from "../store";
import { useT } from "../i18n";

const KEYS = {
  allowedEmailDomains: "auth.allowedEmailDomains",
  mfaRequired: "auth.mfaRequired",
  sessionTtlSeconds: "auth.sessionTtlSeconds",
} as const;

const SESSION_TTL_MIN = 300;
const SESSION_TTL_MAX = 86400;
const SESSION_TTL_DEFAULT = 28800;

type OrgConfigEntry = {
  key: string;
  value: string | number | boolean;
  source: string;
  description?: string;
};

type FormState = {
  allowedEmailDomains: string;
  mfaRequired: boolean;
  sessionTtlSeconds: string;
};

const EMPTY_FORM: FormState = {
  allowedEmailDomains: "",
  mfaRequired: false,
  sessionTtlSeconds: String(SESSION_TTL_DEFAULT),
};

export function AuthPolicySettingsPanel() {
  const { t } = useT();
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion);
  const addToast = useWorkflowStore((state) => state.addToast);
  const platformVersion = useWorkflowStore((state) => state.platformVersion);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api("/org/config")
      .then((data) => {
        if (cancelled) return;
        const entries: OrgConfigEntry[] = (data && typeof data === "object" && "config" in (data as object))
          ? ((data as { config: OrgConfigEntry[] }).config ?? [])
          : [];
        const next: FormState = { ...EMPTY_FORM };
        for (const entry of entries) {
          if (entry.key === KEYS.allowedEmailDomains && typeof entry.value === "string") {
            next.allowedEmailDomains = entry.value;
          }
          if (entry.key === KEYS.mfaRequired && typeof entry.value === "boolean") {
            next.mfaRequired = entry.value;
          }
          if (entry.key === KEYS.sessionTtlSeconds && typeof entry.value === "number") {
            next.sessionTtlSeconds = String(entry.value);
          }
        }
        setForm(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : (t("authPolicy.errorLoad") as string));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [platformVersion, t]);

  const validateForm = (): string | null => {
    const ttl = Number(form.sessionTtlSeconds);
    if (!Number.isFinite(ttl) || !Number.isInteger(ttl)) {
      return t("authPolicy.errorTtlInteger") as string;
    }
    if (ttl < SESSION_TTL_MIN || ttl > SESSION_TTL_MAX) {
      return t("authPolicy.errorTtlRange", { min: SESSION_TTL_MIN, max: SESSION_TTL_MAX }) as string;
    }
    // Lightweight domain-list validation: each entry shouldn't contain spaces
    // or `@`; the server normalizes case + trims further.
    const domains = form.allowedEmailDomains
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const domain of domains) {
      if (domain.includes("@") || domain.includes(" ")) {
        return t("authPolicy.errorInvalidDomain", { domain }) as string;
      }
    }
    return null;
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const issue = validateForm();
    if (issue) {
      setError(issue);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api("/org/config", {
        method: "POST",
        body: JSON.stringify({
          key: KEYS.allowedEmailDomains,
          value: form.allowedEmailDomains.trim(),
        }),
      });
      await api("/org/config", {
        method: "POST",
        body: JSON.stringify({ key: KEYS.mfaRequired, value: form.mfaRequired }),
      });
      await api("/org/config", {
        method: "POST",
        body: JSON.stringify({
          key: KEYS.sessionTtlSeconds,
          value: Number(form.sessionTtlSeconds),
        }),
      });
      addToast(t("authPolicy.toastSaved"), "success");
      bumpPlatformVersion();
    } catch (err) {
      setError(err instanceof Error ? err.message : (t("authPolicy.errorSave") as string));
    } finally {
      setSaving(false);
    }
  };

  // Live TTL validity drives inline feedback + the save gate (mirrors the
  // range checked in validateForm) so the operator sees the problem before
  // submitting, not after.
  const ttlNumber = Number(form.sessionTtlSeconds);
  const ttlValid =
    Number.isInteger(ttlNumber) && ttlNumber >= SESSION_TTL_MIN && ttlNumber <= SESSION_TTL_MAX;

  return (
    <section className="we-budget-settings" aria-labelledby="auth-policy-heading">
      <header className="we-budget-settings__header">
        <ShieldCheck size={18} aria-hidden="true" />
        <h3 id="auth-policy-heading">{t("authPolicy.heading")}</h3>
      </header>

      {loading ? (
        <p className="we-budget-settings__status">{t("authPolicy.loading")}</p>
      ) : (
        <form className="we-budget-settings__form" onSubmit={save} noValidate>
          <fieldset className="we-fieldset">
            <legend>{t("authPolicy.groupAccess")}</legend>
            <label className="we-field">
              <span className="we-field__label">{t("authPolicy.allowedDomains")}</span>
              <input
                type="text"
                className="we-field__input"
                placeholder={t("authPolicy.allowedDomainsPlaceholder") as string}
                value={form.allowedEmailDomains}
                onChange={(e) => setForm({ ...form, allowedEmailDomains: e.target.value })}
              />
              <small className="we-field__hint">{t("authPolicy.allowedDomainsHint")}</small>
            </label>
          </fieldset>

          <fieldset className="we-fieldset">
            <legend>{t("authPolicy.groupSecurity")}</legend>
            <label className="we-field we-field--checkbox">
              <input
                type="checkbox"
                checked={form.mfaRequired}
                onChange={(e) => setForm({ ...form, mfaRequired: e.target.checked })}
              />
              <span className="we-field__label">{t("authPolicy.mfaRequired")}</span>
              <small className="we-field__hint">{t("authPolicy.mfaRequiredHint")}</small>
            </label>

            <label className="we-field">
              <span className="we-field__label">{t("authPolicy.sessionTtl")}</span>
              <input
                type="number"
                className="we-field__input"
                min={SESSION_TTL_MIN}
                max={SESSION_TTL_MAX}
                step={60}
                value={form.sessionTtlSeconds}
                onChange={(e) => setForm({ ...form, sessionTtlSeconds: e.target.value })}
                aria-invalid={!ttlValid}
                aria-describedby={!ttlValid ? "auth-ttl-error" : undefined}
              />
              <small className="we-field__hint">
                {t("authPolicy.sessionTtlHint", { defaultTtl: SESSION_TTL_DEFAULT, min: SESSION_TTL_MIN, max: SESSION_TTL_MAX })}
              </small>
              {!ttlValid && (
                <small id="auth-ttl-error" className="helper-text helper-text--error" role="alert">
                  {t("authPolicy.errorTtlRange", { min: SESSION_TTL_MIN, max: SESSION_TTL_MAX })}
                </small>
              )}
            </label>
          </fieldset>

          {error && (
            <div className="we-budget-settings__error" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="we-button we-button--primary we-budget-settings__save"
            disabled={saving || !ttlValid}
          >
            {saving ? (
              <>{t("authPolicy.saving")}</>
            ) : (
              <>
                <Save size={14} aria-hidden="true" /> {t("authPolicy.save")}
              </>
            )}
            {!saving && form.allowedEmailDomains.trim().length > 0 && (
              <CheckCircle2 size={14} aria-hidden="true" />
            )}
          </button>
        </form>
      )}
    </section>
  );
}
