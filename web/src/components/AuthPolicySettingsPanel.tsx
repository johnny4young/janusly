/**
 * Authentication policy admin editor — mounted inside `OperationsPage`.
 *
 * Four controls written to `POST /org/config`:
 *
 *   - `auth.allowedEmailDomains` (CSV, empty = no restriction)
 *   - `auth.mfaRequired` (boolean, marker only — provider enforces)
 *   - `auth.sessionTtlSeconds` (range 300..86400)
 *   - `runs.humanFormResumeTtlSeconds` (range 300..604800)
 *
 * Admin-only. Calls `bumpPlatformVersion()` after a successful save so
 * any panel that reads org config refetches.
 *
 * Used by `OperationsPage.tsx`.
 */

import React, { useEffect, useState } from "react";
import { ShieldCheck, Save } from "lucide-react";
import { api } from "../api";
import { useWorkflowStore } from "../store";
import { useT } from "../i18n";
import { Button } from "./ui/Button";
import { FormActions, FormField, FormSection } from "./ui/Form";
import { StatusSummary } from "./ui/StatusSummary";
import { SwitchField } from "./ui/SwitchField";
import { parseOrgConfigEntries } from "../lib/org-config-model";

const KEYS = {
  allowedEmailDomains: "auth.allowedEmailDomains",
  mfaRequired: "auth.mfaRequired",
  sessionTtlSeconds: "auth.sessionTtlSeconds",
  humanFormResumeTtlSeconds: "runs.humanFormResumeTtlSeconds",
} as const;

const SESSION_TTL_MIN = 300;
const SESSION_TTL_MAX = 86400;
const SESSION_TTL_DEFAULT = 28800;
const RESUME_TTL_MIN = 300;
const RESUME_TTL_MAX = 604800;
const RESUME_TTL_DEFAULT = 604800;


type FormState = {
  allowedEmailDomains: string;
  mfaRequired: boolean;
  sessionTtlSeconds: string;
  humanFormResumeTtlSeconds: string;
};

const EMPTY_FORM: FormState = {
  allowedEmailDomains: "",
  mfaRequired: false,
  sessionTtlSeconds: String(SESSION_TTL_DEFAULT),
  humanFormResumeTtlSeconds: String(RESUME_TTL_DEFAULT),
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
        const entries = parseOrgConfigEntries(data);
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
          if (entry.key === KEYS.humanFormResumeTtlSeconds && typeof entry.value === "number") {
            next.humanFormResumeTtlSeconds = String(entry.value);
          }
        }
        setForm(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : (t("authPolicy.errorLoad")));
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
      return t("authPolicy.errorTtlInteger");
    }
    if (ttl < SESSION_TTL_MIN || ttl > SESSION_TTL_MAX) {
      return t("authPolicy.errorTtlRange", { min: SESSION_TTL_MIN, max: SESSION_TTL_MAX });
    }
    const resumeTtl = Number(form.humanFormResumeTtlSeconds);
    if (!Number.isFinite(resumeTtl) || !Number.isInteger(resumeTtl)) {
      return t("authPolicy.errorResumeTtlInteger");
    }
    if (resumeTtl < RESUME_TTL_MIN || resumeTtl > RESUME_TTL_MAX) {
      return t("authPolicy.errorResumeTtlRange", { min: RESUME_TTL_MIN, max: RESUME_TTL_MAX });
    }
    // Lightweight domain-list validation: each entry shouldn't contain spaces
    // or `@`; the server normalizes case + trims further.
    const domains = form.allowedEmailDomains
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const domain of domains) {
      if (domain.includes("@") || domain.includes(" ")) {
        return t("authPolicy.errorInvalidDomain", { domain });
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
        body: JSON.stringify({
          key: KEYS.humanFormResumeTtlSeconds,
          value: Number(form.humanFormResumeTtlSeconds),
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
      setError(err instanceof Error ? err.message : (t("authPolicy.errorSave")));
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
  const resumeTtlNumber = Number(form.humanFormResumeTtlSeconds);
  const resumeTtlValid =
    Number.isInteger(resumeTtlNumber) && resumeTtlNumber >= RESUME_TTL_MIN && resumeTtlNumber <= RESUME_TTL_MAX;

  return (
    <section className="we-budget-settings" aria-labelledby="auth-policy-heading" data-testid="auth-policy-settings">
      <header className="we-budget-settings__header">
        <ShieldCheck size={18} aria-hidden="true" />
        <h3 id="auth-policy-heading">{t("authPolicy.heading")}</h3>
      </header>

      {loading ? (
        <StatusSummary title={t("authPolicy.loading")} />
      ) : (
        <form className="ui-form-layout" onSubmit={save} noValidate>
          <FormSection title={t("authPolicy.groupAccess")}>
            <FormField
              id="auth-allowed-domains"
              label={t("authPolicy.allowedDomains")}
              hint={t("authPolicy.allowedDomainsHint")}
            >
              {(controlProps) => (
                <input
                  {...controlProps}
                  type="text"
                  placeholder={t("authPolicy.allowedDomainsPlaceholder")}
                  value={form.allowedEmailDomains}
                  onChange={(e) => setForm({ ...form, allowedEmailDomains: e.target.value })}
                />
              )}
            </FormField>
          </FormSection>

          <FormSection title={t("authPolicy.groupSecurity")}>
            <SwitchField
              checked={form.mfaRequired}
              onChange={(e) => setForm({ ...form, mfaRequired: e.target.checked })}
              label={t("authPolicy.mfaRequired")}
              hint={t("authPolicy.mfaRequiredHint")}
            />
            <FormField
              id="auth-session-ttl"
              label={t("authPolicy.sessionTtl")}
              hint={t("authPolicy.sessionTtlHint", { defaultTtl: SESSION_TTL_DEFAULT, min: SESSION_TTL_MIN, max: SESSION_TTL_MAX })}
              error={!ttlValid ? t("authPolicy.errorTtlRange", { min: SESSION_TTL_MIN, max: SESSION_TTL_MAX }) : undefined}
            >
              {(controlProps) => (
                <input
                  {...controlProps}
                  type="number"
                  min={SESSION_TTL_MIN}
                  max={SESSION_TTL_MAX}
                  step={60}
                  value={form.sessionTtlSeconds}
                  onChange={(e) => setForm({ ...form, sessionTtlSeconds: e.target.value })}
                />
              )}
            </FormField>
            <FormField
              id="auth-resume-ttl"
              label={t("authPolicy.resumeTtl")}
              hint={t("authPolicy.resumeTtlHint", { defaultTtl: RESUME_TTL_DEFAULT, min: RESUME_TTL_MIN, max: RESUME_TTL_MAX })}
              error={!resumeTtlValid ? t("authPolicy.errorResumeTtlRange", { min: RESUME_TTL_MIN, max: RESUME_TTL_MAX }) : undefined}
            >
              {(controlProps) => (
                <input
                  {...controlProps}
                  type="number"
                  min={RESUME_TTL_MIN}
                  max={RESUME_TTL_MAX}
                  step={60}
                  value={form.humanFormResumeTtlSeconds}
                  onChange={(e) => setForm({ ...form, humanFormResumeTtlSeconds: e.target.value })}
                />
              )}
            </FormField>
          </FormSection>

          {error && (
            <StatusSummary role="alert" tone="danger" title={error} />
          )}

          <FormActions>
            <Button
              type="submit"
              variant="primary"
              disabled={saving || !ttlValid || !resumeTtlValid}
              loading={saving}
              loadingLabel={t("authPolicy.saving")}
              leadingIcon={<Save size={15} />}
            >
              {t("authPolicy.save")}
            </Button>
          </FormActions>
        </form>
      )}
    </section>
  );
}
