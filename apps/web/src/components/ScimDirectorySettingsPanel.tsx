/**
 * SCIM directory admin panel — mounted inside `OperationsPage`.
 *
 * Admins attach one WorkOS Directory id per org with a default role
 * (viewer / editor / admin) and a directory type label. SCIM-
 * provisioned users get a role DERIVED from their IdP group
 * memberships: the highest-ranked group→role mapping among the groups
 * they belong to, falling back to the directory `defaultRole` when no
 * group is mapped. The "Group → role mappings" section below the
 * directory form is where the admin configures those mappings (a synced
 * group is picked by name, not by raw id).
 *
 * Admin-only. Calls `bumpPlatformVersion()` after a successful
 * attach / revoke / mapping change so other panels that depend on
 * membership counts refetch.
 *
 * Used by `OperationsPage.tsx`.
 */

import React, { useEffect, useMemo, useState } from "react";
import { ClipboardList, Link2, Plus, Save, Trash2 } from "lucide-react";

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

/** One synced IdP group, as returned by `GET /org/scim/groups`. The
 *  picker shows `name`; `providerGroupId` is the stable id the mapping
 *  is keyed on. */
type ScimGroupRow = {
  id: string;
  providerGroupId: string;
  name: string;
};

/** One configured group→role mapping, as returned by
 *  `GET /org/scim/group-role-mappings`. `role` is one of the three
 *  built-ins (custom-role mapping is not supported yet). */
type ScimGroupRoleMappingRow = {
  id: string;
  scimDirectoryId: string;
  providerGroupId: string;
  role: string;
};

const EMPTY_FORM: { providerDirectoryId: string; directoryType: string; defaultRole: DefaultRole } = {
  providerDirectoryId: "",
  directoryType: "",
  defaultRole: "viewer",
};

const ROLES: readonly DefaultRole[] = ["viewer", "editor", "admin"];

export function ScimDirectorySettingsPanel() {
  const { t } = useT();
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion);
  const addToast = useWorkflowStore((state) => state.addToast);
  const platformVersion = useWorkflowStore((state) => state.platformVersion);

  const [directories, setDirectories] = useState<ScimDirectoryRow[]>([]);
  const [mappings, setMappings] = useState<ScimGroupRoleMappingRow[]>([]);
  const [groups, setGroups] = useState<ScimGroupRow[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [mappingForm, setMappingForm] = useState<{ providerGroupId: string; role: DefaultRole }>({
    providerGroupId: "",
    role: "viewer",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addingMapping, setAddingMapping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Directories drive the panel's loading/error state; the mapping +
    // group reads are best-effort (they resolve the org's directory
    // server-side and return [] when none is attached), so a transient
    // failure there shows an empty mappings section rather than blanking
    // the whole panel.
    Promise.all([
      api("/org/scim/directories"),
      api("/org/scim/group-role-mappings").catch(() => [] as unknown),
      api("/org/scim/groups").catch(() => [] as unknown),
    ])
      .then(([dirs, maps, grps]) => {
        if (cancelled) return;
        setDirectories(Array.isArray(dirs) ? (dirs as ScimDirectoryRow[]) : []);
        setMappings(Array.isArray(maps) ? (maps as ScimGroupRoleMappingRow[]) : []);
        setGroups(Array.isArray(grps) ? (grps as ScimGroupRow[]) : []);
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

  const activeDirectory = directories.find((d) => d.status === "active") ?? null;

  const mappedGroupIds = useMemo(
    () => new Set(mappings.map((m) => m.providerGroupId)),
    [mappings],
  );
  const unmappedGroups = useMemo(
    () => groups.filter((g) => !mappedGroupIds.has(g.providerGroupId)),
    [groups, mappedGroupIds],
  );
  const groupName = (providerGroupId: string) =>
    groups.find((g) => g.providerGroupId === providerGroupId)?.name ?? providerGroupId;

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

  const addMapping = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!mappingForm.providerGroupId) return;
    setAddingMapping(true);
    try {
      await api("/org/scim/group-role-mappings", {
        method: "POST",
        body: JSON.stringify({ providerGroupId: mappingForm.providerGroupId, role: mappingForm.role }),
      });
      addToast(t("scim.mappings.toast.added"), "success");
      setMappingForm({ providerGroupId: "", role: "viewer" });
      bumpPlatformVersion();
    } catch (err) {
      addToast(err instanceof Error ? err.message : (t("scim.mappings.errorAdd") as string), "error");
    } finally {
      setAddingMapping(false);
    }
  };

  const updateMappingRole = async (row: ScimGroupRoleMappingRow, role: DefaultRole) => {
    if (role === row.role) return;
    try {
      await api(`/org/scim/group-role-mappings/${row.id}`, {
        method: "POST",
        body: JSON.stringify({ role }),
      });
      addToast(t("scim.mappings.toast.updated"), "success");
      bumpPlatformVersion();
    } catch (err) {
      addToast(err instanceof Error ? err.message : (t("scim.mappings.errorUpdate") as string), "error");
    }
  };

  const removeMapping = async (row: ScimGroupRoleMappingRow) => {
    if (!window.confirm(t("scim.mappings.removePrompt", { group: groupName(row.providerGroupId) }) as string)) {
      return;
    }
    try {
      await api(`/org/scim/group-role-mappings/${row.id}`, { method: "DELETE" });
      addToast(t("scim.mappings.toast.removed"), "success");
      bumpPlatformVersion();
    } catch (err) {
      addToast(err instanceof Error ? err.message : (t("scim.mappings.errorRemove") as string), "error");
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

          {activeDirectory && (
            <section className="we-scim-mappings" aria-labelledby="scim-mappings-heading">
              <header className="we-budget-settings__header">
                <h4 id="scim-mappings-heading">{t("scim.mappings.heading")}</h4>
              </header>
              <p className="we-field__hint">{t("scim.mappings.intro")}</p>

              {mappings.length > 0 ? (
                <table className="we-table we-table--compact" aria-label={t("scim.mappings.list.aria")}>
                  <thead>
                    <tr>
                      <th>{t("scim.mappings.col.group")}</th>
                      <th>{t("scim.mappings.col.role")}</th>
                      <th aria-label={t("scim.mappings.col.actions")} />
                    </tr>
                  </thead>
                  <tbody>
                    {mappings.map((row) => (
                      <tr key={row.id}>
                        <td>{groupName(row.providerGroupId)}</td>
                        <td>
                          <select
                            className="we-field__input"
                            value={row.role}
                            aria-label={t("scim.mappings.roleAria", { group: groupName(row.providerGroupId) }) as string}
                            onChange={(e) => updateMappingRole(row, e.target.value as DefaultRole)}
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>{t(`scim.role.${r}`)}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="we-button we-button--ghost"
                            onClick={() => removeMapping(row)}
                            aria-label={t("scim.mappings.removeAria", { group: groupName(row.providerGroupId) }) as string}
                          >
                            <Trash2 size={14} aria-hidden="true" /> {t("scim.mappings.remove")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : groups.length === 0 ? (
                <p className="we-budget-settings__status">{t("scim.mappings.emptyNoGroups")}</p>
              ) : (
                <p className="we-budget-settings__status">{t("scim.mappings.emptyNoMappings")}</p>
              )}

              {groups.length > 0 && (
                unmappedGroups.length > 0 ? (
                  <form className="we-budget-settings__form" onSubmit={addMapping} noValidate>
                    <label className="we-field">
                      <span className="we-field__label">{t("scim.mappings.add.group")}</span>
                      <select
                        className="we-field__input"
                        value={mappingForm.providerGroupId}
                        onChange={(e) => setMappingForm({ ...mappingForm, providerGroupId: e.target.value })}
                      >
                        <option value="">{t("scim.mappings.add.groupPlaceholder")}</option>
                        {unmappedGroups.map((g) => (
                          <option key={g.providerGroupId} value={g.providerGroupId}>{g.name}</option>
                        ))}
                      </select>
                    </label>

                    <label className="we-field">
                      <span className="we-field__label">{t("scim.mappings.add.role")}</span>
                      <select
                        className="we-field__input"
                        value={mappingForm.role}
                        onChange={(e) => setMappingForm({ ...mappingForm, role: e.target.value as DefaultRole })}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{t(`scim.role.${r}`)}</option>
                        ))}
                      </select>
                    </label>

                    <button
                      type="submit"
                      className="we-button we-button--primary we-budget-settings__save"
                      disabled={addingMapping || !mappingForm.providerGroupId}
                    >
                      {addingMapping
                        ? <>{t("scim.mappings.add.adding")}</>
                        : <><Plus size={14} aria-hidden="true" /> {t("scim.mappings.add.submit")}</>}
                    </button>
                  </form>
                ) : (
                  <p className="we-budget-settings__status">{t("scim.mappings.allMapped")}</p>
                )
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
