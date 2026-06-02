/**
 * SCIM directory admin panel — mounted inside `OperationsPage`.
 *
 * Admins attach one WorkOS Directory id per org with a default role
 * (viewer / editor / admin) and a directory type label. SCIM-
 * provisioned users get the configured `defaultRole`; v1 has no per-
 * group role overrides.
 *
 * Admin-only. Calls `bumpPlatformVersion()` after a successful
 * attach / revoke so other panels that depend on membership counts
 * refetch.
 *
 * Used by `OperationsPage.tsx`.
 */

import React, { useEffect, useState } from "react";
import { ClipboardList, Link2, Save, Trash2 } from "lucide-react";

import { api } from "../api";
import { useWorkflowStore } from "../store";
import { getResolvedLocale, useT } from "../i18n";

type DefaultRole = "viewer" | "editor" | "admin";
type DirectoryStatus = "active" | "revoked";

type ScimDirectoryRow = {
  id: string;
  orgId: string;
  providerDirectoryId: string;
  directoryType: string | null;
  defaultRole: DefaultRole;
  status: DirectoryStatus;
  lastSyncedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const EMPTY_FORM: { providerDirectoryId: string; directoryType: string; defaultRole: DefaultRole } = {
  providerDirectoryId: "",
  directoryType: "",
  defaultRole: "viewer",
};

export function ScimDirectorySettingsPanel() {
  const { t } = useT();
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion);
  const addToast = useWorkflowStore((state) => state.addToast);
  const platformVersion = useWorkflowStore((state) => state.platformVersion);

  const [directories, setDirectories] = useState<ScimDirectoryRow[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api("/org/scim/directories")
      .then((data) => {
        if (cancelled) return;
        const rows = Array.isArray(data) ? (data as ScimDirectoryRow[]) : [];
        setDirectories(rows);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : (t("scim.errorLoad") as string));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [platformVersion, t]);

  const attach = async (event: React.FormEvent) => {
    event.preventDefault();
    const providerDirectoryId = form.providerDirectoryId.trim();
    if (!providerDirectoryId) {
      setError(t("scim.errorMissing") as string);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api("/org/scim/directories", {
        method: "POST",
        body: JSON.stringify({
          providerDirectoryId,
          directoryType: form.directoryType.trim() || undefined,
          defaultRole: form.defaultRole,
        }),
      });
      addToast(t("scim.toast.attached"), "success");
      setForm(EMPTY_FORM);
      bumpPlatformVersion();
    } catch (err) {
      setError(err instanceof Error ? err.message : (t("scim.errorAttach") as string));
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (row: ScimDirectoryRow) => {
    if (!window.confirm(t("scim.disconnectPrompt", { id: row.providerDirectoryId }) as string)) {
      return;
    }
    try {
      await api(`/org/scim/directories/${row.id}`, { method: "DELETE" });
      addToast(t("scim.toast.disconnected"), "success");
      bumpPlatformVersion();
    } catch (err) {
      addToast(err instanceof Error ? err.message : (t("scim.errorDisconnect") as string), "error");
    }
  };

  return (
    <section className="we-budget-settings" aria-labelledby="scim-heading">
      <header className="we-budget-settings__header">
        <ClipboardList size={18} aria-hidden="true" />
        <h3 id="scim-heading">{t("scim.heading")}</h3>
      </header>

      {loading ? (
        <p className="we-budget-settings__status">{t("scim.loading")}</p>
      ) : (
        <>
          {directories.length > 0 && (
            <table className="we-table we-table--compact" aria-label={t("scim.list.aria")}>
              <thead>
                <tr>
                  <th>{t("scim.col.directoryId")}</th>
                  <th>{t("scim.col.type")}</th>
                  <th>{t("scim.col.defaultRole")}</th>
                  <th>{t("scim.col.status")}</th>
                  <th>{t("scim.col.lastSynced")}</th>
                  <th aria-label={t("scim.col.actions")} />
                </tr>
              </thead>
              <tbody>
                {directories.map((row) => (
                  <tr key={row.id}>
                    <td><code>{row.providerDirectoryId}</code></td>
                    <td>{row.directoryType || "—"}</td>
                    <td>{row.defaultRole}</td>
                    <td>{row.status}</td>
                    <td>{row.lastSyncedAt ? new Date(row.lastSyncedAt).toLocaleString(getResolvedLocale()) : "—"}</td>
                    <td>
                      {row.status === "active" && (
                        <button
                          type="button"
                          className="we-button we-button--ghost"
                          onClick={() => revoke(row)}
                          aria-label={t("scim.disconnectAria", { id: row.providerDirectoryId }) as string}
                        >
                          <Trash2 size={14} aria-hidden="true" /> {t("scim.disconnect")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {directories.filter((d) => d.status === "active").length === 0 && (
            <form className="we-budget-settings__form" onSubmit={attach} noValidate>
              <label className="we-field">
                <span className="we-field__label">{t("scim.field.directoryId")}</span>
                <input
                  type="text"
                  className="we-field__input"
                  placeholder={t("scim.field.directoryIdPlaceholder") as string}
                  value={form.providerDirectoryId}
                  onChange={(e) => setForm({ ...form, providerDirectoryId: e.target.value })}
                />
                <small className="we-field__hint">{t("scim.field.directoryIdHint")}</small>
              </label>

              <label className="we-field">
                <span className="we-field__label">{t("scim.field.type")}</span>
                <input
                  type="text"
                  className="we-field__input"
                  placeholder={t("scim.field.typePlaceholder") as string}
                  value={form.directoryType}
                  onChange={(e) => setForm({ ...form, directoryType: e.target.value })}
                />
              </label>

              <label className="we-field">
                <span className="we-field__label">{t("scim.field.defaultRole")}</span>
                <select
                  className="we-field__input"
                  value={form.defaultRole}
                  onChange={(e) => setForm({ ...form, defaultRole: e.target.value as DefaultRole })}
                >
                  <option value="viewer">{t("scim.role.viewer")}</option>
                  <option value="editor">{t("scim.role.editor")}</option>
                  <option value="admin">{t("scim.role.admin")}</option>
                </select>
                <small className="we-field__hint">{t("scim.field.defaultRoleHint")}</small>
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
                {saving ? <>{t("scim.connecting")}</> : <><Link2 size={14} aria-hidden="true" /> {t("scim.connect")}</>}
                {!saving && <Save size={14} aria-hidden="true" />}
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
