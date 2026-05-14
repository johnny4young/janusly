/**
 * SCIM directory admin panel — mounted inside `OperationsPanel`.
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
 * Used by `OperationsPanel.tsx`.
 */

import React, { useEffect, useState } from "react";
import { ClipboardList, Link2, Save, Trash2 } from "lucide-react";

import { api } from "../api";
import { useWorkflowStore } from "../store";

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
        if (!cancelled) setError(err instanceof Error ? err.message : "failed to load SCIM directories");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [platformVersion]);

  const attach = async (event: React.FormEvent) => {
    event.preventDefault();
    const providerDirectoryId = form.providerDirectoryId.trim();
    if (!providerDirectoryId) {
      setError("WorkOS Directory ID is required");
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
      addToast("SCIM directory attached", "success");
      setForm(EMPTY_FORM);
      bumpPlatformVersion();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to attach directory");
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (row: ScimDirectoryRow) => {
    if (!window.confirm(`Disconnect SCIM directory ${row.providerDirectoryId}?\n\nDoes not delete existing memberships.`)) {
      return;
    }
    try {
      await api(`/org/scim/directories/${row.id}`, { method: "DELETE" });
      addToast("SCIM directory disconnected", "success");
      bumpPlatformVersion();
    } catch (err) {
      addToast(err instanceof Error ? err.message : "failed to disconnect", "error");
    }
  };

  return (
    <section className="we-budget-settings" aria-labelledby="scim-heading">
      <header className="we-budget-settings__header">
        <ClipboardList size={18} aria-hidden="true" />
        <h3 id="scim-heading">SCIM directory sync</h3>
      </header>

      {loading ? (
        <p className="we-budget-settings__status">Loading SCIM directories…</p>
      ) : (
        <>
          {directories.length > 0 && (
            <table className="we-table we-table--compact" aria-label="Connected SCIM directories">
              <thead>
                <tr>
                  <th>Directory ID</th>
                  <th>Type</th>
                  <th>Default role</th>
                  <th>Status</th>
                  <th>Last synced</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {directories.map((row) => (
                  <tr key={row.id}>
                    <td><code>{row.providerDirectoryId}</code></td>
                    <td>{row.directoryType || "—"}</td>
                    <td>{row.defaultRole}</td>
                    <td>{row.status}</td>
                    <td>{row.lastSyncedAt ? new Date(row.lastSyncedAt).toLocaleString() : "—"}</td>
                    <td>
                      {row.status === "active" && (
                        <button
                          type="button"
                          className="we-button we-button--ghost"
                          onClick={() => revoke(row)}
                          aria-label={`Disconnect directory ${row.providerDirectoryId}`}
                        >
                          <Trash2 size={14} aria-hidden="true" /> Disconnect
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
                <span className="we-field__label">WorkOS Directory ID</span>
                <input
                  type="text"
                  className="we-field__input"
                  placeholder="directory_01…"
                  value={form.providerDirectoryId}
                  onChange={(e) => setForm({ ...form, providerDirectoryId: e.target.value })}
                />
                <small className="we-field__hint">
                  Copy this from your WorkOS dashboard after the IdP admin connects Okta /
                  Azure AD / Google Workspace.
                </small>
              </label>

              <label className="we-field">
                <span className="we-field__label">Directory type (optional label)</span>
                <input
                  type="text"
                  className="we-field__input"
                  placeholder="okta_scim, azure_scim, gsuite, …"
                  value={form.directoryType}
                  onChange={(e) => setForm({ ...form, directoryType: e.target.value })}
                />
              </label>

              <label className="we-field">
                <span className="we-field__label">Default role for provisioned users</span>
                <select
                  className="we-field__input"
                  value={form.defaultRole}
                  onChange={(e) => setForm({ ...form, defaultRole: e.target.value as DefaultRole })}
                >
                  <option value="viewer">viewer</option>
                  <option value="editor">editor</option>
                  <option value="admin">admin</option>
                </select>
                <small className="we-field__hint">
                  Per-group role overrides are deferred to v2; every SCIM-provisioned user
                  gets this role.
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
                {saving ? <>Connecting…</> : <><Link2 size={14} aria-hidden="true" /> Connect directory</>}
                {!saving && <Save size={14} aria-hidden="true" />}
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
