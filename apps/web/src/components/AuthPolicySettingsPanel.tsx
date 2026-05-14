/**
 * Authentication policy admin editor — mounted inside `OperationsPanel`.
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
 * Used by `OperationsPanel.tsx`.
 */

import React, { useEffect, useState } from "react";
import { CheckCircle2, ShieldCheck, Save } from "lucide-react";
import { api } from "../api";
import { useWorkflowStore } from "../store";

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
        if (!cancelled) setError(err instanceof Error ? err.message : "failed to load auth policies");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [platformVersion]);

  const validateForm = (): string | null => {
    const ttl = Number(form.sessionTtlSeconds);
    if (!Number.isFinite(ttl) || !Number.isInteger(ttl)) {
      return "Session TTL must be a whole number of seconds";
    }
    if (ttl < SESSION_TTL_MIN || ttl > SESSION_TTL_MAX) {
      return `Session TTL must be between ${SESSION_TTL_MIN} and ${SESSION_TTL_MAX} seconds`;
    }
    // Lightweight domain-list validation: each entry shouldn't contain spaces
    // or `@`; the server normalizes case + trims further.
    const domains = form.allowedEmailDomains
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const domain of domains) {
      if (domain.includes("@") || domain.includes(" ")) {
        return `Invalid domain "${domain}" — use bare domains like "acme.com"`;
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
      addToast("Authentication policies saved", "success");
      bumpPlatformVersion();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="we-budget-settings" aria-labelledby="auth-policy-heading">
      <header className="we-budget-settings__header">
        <ShieldCheck size={18} aria-hidden="true" />
        <h3 id="auth-policy-heading">Authentication policies</h3>
      </header>

      {loading ? (
        <p className="we-budget-settings__status">Loading authentication policies…</p>
      ) : (
        <form className="we-budget-settings__form" onSubmit={save} noValidate>
          <label className="we-field">
            <span className="we-field__label">Allowed email domains</span>
            <input
              type="text"
              className="we-field__input"
              placeholder="acme.com, partner.com"
              value={form.allowedEmailDomains}
              onChange={(e) => setForm({ ...form, allowedEmailDomains: e.target.value })}
            />
            <small className="we-field__hint">
              Comma-separated list. Leave empty to allow any email domain. Applies to both
              direct Supabase logins and SSO-authenticated sessions.
            </small>
          </label>

          <label className="we-field we-field--checkbox">
            <input
              type="checkbox"
              checked={form.mfaRequired}
              onChange={(e) => setForm({ ...form, mfaRequired: e.target.checked })}
            />
            <span className="we-field__label">Require multi-factor authentication</span>
            <small className="we-field__hint">
              Marker only. Multi-factor authentication is enforced by your identity provider
              (Okta, Azure AD, etc.) — Janusly stores the requirement for policy visibility
              but does not itself block logins that lack a verified MFA claim.
            </small>
          </label>

          <label className="we-field">
            <span className="we-field__label">Session TTL (seconds)</span>
            <input
              type="number"
              className="we-field__input"
              min={SESSION_TTL_MIN}
              max={SESSION_TTL_MAX}
              step={60}
              value={form.sessionTtlSeconds}
              onChange={(e) => setForm({ ...form, sessionTtlSeconds: e.target.value })}
            />
            <small className="we-field__hint">
              Lifetime of SSO-issued session tokens. Default {SESSION_TTL_DEFAULT} (8 hours).
              Range {SESSION_TTL_MIN}..{SESSION_TTL_MAX} (5 minutes..24 hours). Existing
              session tokens keep their original expiry; only newly-minted ones use this.
            </small>
          </label>

          {error && (
            <div className="we-budget-settings__error" role="alert">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="we-button we-button--primary we-budget-settings__save"
            disabled={saving}
          >
            {saving ? (
              <>Saving…</>
            ) : (
              <>
                <Save size={14} aria-hidden="true" /> Save policies
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
