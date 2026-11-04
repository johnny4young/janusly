/**
 * Permission grants admin panel — mounted inside `OperationsPage`.
 *
 * Renders the closed permission catalog as one matrix: permissions grouped by
 * category in rows, roles in columns (built-ins first, custom roles after).
 * Admins can:
 *
 *   - Override a built-in role's permission set (or revert to
 *     catalog defaults). One Save posts each edited role separately.
 *   - Create a custom role (`compliance`, `ops-readonly`, …) with
 *     `inheritsFrom` rank inheritance + an explicit permission set.
 *   - Edit / delete custom roles (built-ins can't be deleted).
 *
 * Admin-only. Calls `bumpPlatformVersion(PERMISSION_MUTATION_TAGS)` after a successful save so
 * panels that depend on roles (MembersPanel) refetch.
 *
 * Used by `OperationsPage.tsx`.
 */

import React, { useEffect, useMemo, useState } from "react";
import { AlertCircle, KeyRound, Plus, RotateCcw, Save, Trash2 } from "lucide-react";

import { api } from "../api";
import { useWorkflowStore } from "../store";
import { tApiError, useT } from "../i18n";
import { useConfirm } from "./ConfirmDialog";
import { Button } from "./ui/Button";
import { FormActions, FormField, FormGrid, TextInput } from "./ui/Form";
import { StatusSummary } from "./ui/StatusSummary";
import './PermissionGrantsPanel.css'
import { PLATFORM_TAG, useInvalidationNonce, type ResourceTag } from '../lib/query-cache'

const PERMISSION_TAGS = [PLATFORM_TAG, 'roles'] as const

const PERMISSION_MUTATION_TAGS: readonly ResourceTag[] = ['roles', 'members']

type Role = "viewer" | "editor" | "admin";

type CatalogEntry = {
  key: string;
  category: string;
  description: string;
  defaultRoles: readonly Role[];
};

type RoleEntry = {
  id?: string;
  name: string;
  isBuiltin: boolean;
  inheritsFrom: Role;
  description: string | null;
  grantedPermissions: string[] | null;
};

type SaveFailure = { role: string; message: string };

const ROLE_ORDER: Role[] = ["viewer", "editor", "admin"];

/** Custom role names: lowercase alphanumerics plus `_`/`-`, 1–32 chars. Mirrors
 *  the server-side validation so the operator sees the rule before submitting. */
const ROLE_NAME_RE = /^[a-z0-9_-]{1,32}$/;

function sameKeys(a: Set<string>, b: Set<string>) {
  return a.size === b.size && [...a].every((key) => b.has(key));
}

export function PermissionGrantsPanel({ canWrite = true }: { canWrite?: boolean } = {}) {
  const { t } = useT();
  const confirmDialog = useConfirm();
  const bumpPlatformVersion = useWorkflowStore((s) => s.bumpPlatformVersion);
  const addToast = useWorkflowStore((s) => s.addToast);
  const invalidationNonce = useInvalidationNonce(PERMISSION_TAGS);

  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [mandatoryAdmin, setMandatoryAdmin] = useState<string[]>([]);
  const [roles, setRoles] = useState<RoleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleInherits, setNewRoleInherits] = useState<Role>("viewer");
  const [newRoleDescription, setNewRoleDescription] = useState("");
  const [newRolePermissions, setNewRolePermissions] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);

  // Unsaved grants per role. Roles without a draft always show the server state,
  // so a refetch keeps in-progress edits without freezing untouched roles.
  const [drafts, setDrafts] = useState<Record<string, Set<string>>>({});
  const [saving, setSaving] = useState(false);
  const [saveReport, setSaveReport] = useState<{ total: number; failures: SaveFailure[] } | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api("/org/permissions/catalog"), api("/org/roles")])
      .then(([catalogResp, rolesResp]) => {
        if (cancelled) return;
        const c = (catalogResp as { catalog?: CatalogEntry[]; mandatoryAdminPermissions?: string[] }) ?? {};
        setCatalog(c.catalog ?? []);
        setMandatoryAdmin(c.mandatoryAdminPermissions ?? []);
        const r = (rolesResp as { roles?: RoleEntry[] }) ?? {};
        setRoles(r.roles ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : (t("permissions.errorLoad")));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [invalidationNonce, t]);

  const grouped = useMemo(() => {
    const out = new Map<string, CatalogEntry[]>();
    for (const e of catalog) {
      const list = out.get(e.category) ?? [];
      list.push(e);
      out.set(e.category, list);
    }
    return Array.from(out.entries());
  }, [catalog]);

  const visibleGroups = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return grouped;
    return grouped
      .map(([category, entries]): [string, CatalogEntry[]] => [
        category,
        entries.filter((entry) =>
          [entry.key, category, entry.description].some((text) => text.toLowerCase().includes(query))),
      ])
      .filter(([, entries]) => entries.length > 0);
  }, [grouped, filter]);

  const savedGrants = useMemo(() => {
    const out: Record<string, Set<string>> = {};
    for (const role of roles) {
      const granted = Array.isArray(role.grantedPermissions)
        ? role.grantedPermissions
        : role.isBuiltin
          ? catalog.filter((entry) => entry.defaultRoles.includes(role.name as Role)).map((entry) => entry.key)
          : [];
      out[role.name] = new Set(granted);
    }
    return out;
  }, [roles, catalog]);

  function toggleGrant(roleName: string, key: string) {
    setDrafts((prev) => {
      const set = new Set(prev[roleName] ?? savedGrants[roleName]);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      return { ...prev, [roleName]: set };
    });
  }

  function dropDrafts(roleNames: readonly string[]) {
    setDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([name]) => !roleNames.includes(name))));
  }

  // The API saves one role per request, so roles can succeed and fail independently.
  async function saveChanges(edited: readonly RoleEntry[]) {
    setSaving(true);
    setSaveReport(null);
    const failures: SaveFailure[] = [];
    const saved = new Map<string, Partial<RoleEntry>>();
    for (const role of edited) {
      const granted = Array.from(drafts[role.name]).sort();
      try {
        const response = (await api(`/org/roles/${encodeURIComponent(role.name)}`, {
          method: "POST",
          body: JSON.stringify({ grantedPermissions: granted }),
        })) as Partial<RoleEntry> | null;
        saved.set(role.name, { ...response, grantedPermissions: response?.grantedPermissions ?? granted });
      } catch (err) {
        failures.push({ role: role.name, message: tApiError(err) || t("permissions.errorSave") });
      }
    }
    if (saved.size > 0) {
      setRoles((prev) => prev.map((role) => ({ ...role, ...saved.get(role.name) })));
      dropDrafts([...saved.keys()]);
      bumpPlatformVersion(PERMISSION_MUTATION_TAGS);
    }
    if (failures.length > 0) setSaveReport({ total: edited.length, failures });
    else addToast(t("permissions.toastUpdated", { role: [...saved.keys()].join(", ") }), "success");
    setSaving(false);
  }

  async function revertBuiltin(role: RoleEntry) {
    if (!(await confirmDialog({ body: t("permissions.confirmRevert", { role: role.name }), tone: "danger" }))) return;
    try {
      await api(`/org/roles/${encodeURIComponent(role.name)}`, { method: "DELETE" });
      addToast(t("permissions.toastReverted", { role: role.name }), "success");
      dropDrafts([role.name]);
      setSaveReport(null);
      bumpPlatformVersion(PERMISSION_MUTATION_TAGS);
    } catch (err) {
      addToast(tApiError(err) || (t("permissions.errorRevert")), "error");
    }
  }

  async function deleteCustom(role: RoleEntry) {
    if (!(await confirmDialog({ body: t("permissions.confirmDelete", { role: role.name }), tone: "danger" }))) return;
    try {
      await api(`/org/roles/${encodeURIComponent(role.name)}`, { method: "DELETE" });
      addToast(t("permissions.toastDeleted", { role: role.name }), "success");
      dropDrafts([role.name]);
      setSaveReport(null);
      bumpPlatformVersion(PERMISSION_MUTATION_TAGS);
    } catch (err) {
      addToast(tApiError(err) || (t("permissions.errorDelete")), "error");
    }
  }

  function toggleNewRolePermission(key: string) {
    setNewRolePermissions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function createRole(event: React.FormEvent) {
    event.preventDefault();
    const name = newRoleName.trim().toLowerCase();
    if (!ROLE_NAME_RE.test(name)) {
      setError(t("permissions.errorName"));
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await api("/org/roles", {
        method: "POST",
        body: JSON.stringify({
          name,
          inheritsFrom: newRoleInherits,
          description: newRoleDescription.trim() || undefined,
          grantedPermissions: Array.from(newRolePermissions).sort(),
        }),
      });
      addToast(t("permissions.toastCreated", { role: name }), "success");
      setNewRoleName("");
      setNewRoleDescription("");
      setNewRolePermissions(new Set());
      setNewRoleInherits("viewer");
      bumpPlatformVersion(PERMISSION_MUTATION_TAGS);
    } catch (err) {
      setError(err instanceof Error ? err.message : (t("permissions.errorCreate")));
    } finally {
      setCreating(false);
    }
  }

  if (loading && roles.length === 0) {
    return (
      <section className="we-budget-settings" aria-labelledby="permissions-heading">
        <header className="we-budget-settings__header">
          <KeyRound size={18} aria-hidden="true" />
          <h3 id="permissions-heading">{t("permissions.heading")}</h3>
        </header>
        <p className="we-budget-settings__status">{t("permissions.loading")}</p>
      </section>
    );
  }

  const builtins = ROLE_ORDER.map((r) => roles.find((row) => row.name === r)).filter((r): r is RoleEntry => r !== undefined);
  const customs = roles.filter((r) => !r.isBuiltin);
  const columns = [...builtins, ...customs];
  const grantsOf = (role: RoleEntry) => drafts[role.name] ?? savedGrants[role.name];
  const editedRoles = columns.filter((role) => drafts[role.name] && !sameKeys(drafts[role.name], savedGrants[role.name]));
  const differsFromDefault = (role: RoleEntry, entry: CatalogEntry) =>
    role.isBuiltin && grantsOf(role).has(entry.key) !== entry.defaultRoles.includes(role.name as Role);
  const changesFromDefault = columns.reduce(
    (sum, role) => sum + catalog.filter((entry) => differsFromDefault(role, entry)).length,
    0,
  );

  // Live validation for the new-role name: flag a non-empty value that breaks
  // the format so the operator sees it before submitting, and gate the submit.
  const trimmedNewRoleName = newRoleName.trim().toLowerCase();
  const newRoleNameInvalid = trimmedNewRoleName.length > 0 && !ROLE_NAME_RE.test(trimmedNewRoleName);
  const canCreateRole = trimmedNewRoleName.length > 0 && !newRoleNameInvalid && !creating;

  return (
    <section className="we-budget-settings" aria-labelledby="permissions-heading" data-testid="permission-grants-panel">
      <div className="we-permissions-bar">
        <div>
          <header className="we-budget-settings__header">
            <KeyRound size={18} aria-hidden="true" />
            <h3 id="permissions-heading">{t("permissions.heading")}</h3>
          </header>
          {columns.length > 0 && (
            <p className="we-permissions-bar__status" aria-live="polite" data-testid="permissions-status">
              {t("permissions.changesFromDefault", { count: changesFromDefault })}
              {editedRoles.length > 0 && (
                <strong> · {t("permissions.unsaved", { roles: editedRoles.map((role) => role.name).join(", ") })}</strong>
              )}
            </p>
          )}
        </div>
        {columns.length > 0 && (
          <div className="we-permissions-bar__controls">
            <TextInput
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("permissions.filter")}
              aria-label={t("permissions.filter")}
              data-testid="permissions-filter"
            />
            {canWrite && (
              <>
                <Button
                  onClick={() => {
                    setDrafts({});
                    setSaveReport(null);
                  }}
                  disabled={editedRoles.length === 0 || saving}
                  data-testid="permissions-discard"
                >
                  {t("permissions.discard")}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => saveChanges(editedRoles)}
                  disabled={editedRoles.length === 0}
                  loading={saving}
                  loadingLabel={t("permissions.saveAll")}
                  leadingIcon={<Save size={14} />}
                  data-testid="permissions-save"
                >
                  {t("permissions.saveAll")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {error && (
        <StatusSummary role="alert" tone="danger" icon={<AlertCircle size={16} />} title={error} />
      )}

      {saveReport && (
        <StatusSummary
          role="alert"
          tone="danger"
          icon={<AlertCircle size={16} />}
          title={t("permissions.savePartial", {
            saved: saveReport.total - saveReport.failures.length,
            total: saveReport.total,
          })}
          description={saveReport.failures.map((failure) => (
            <div key={failure.role}><code>{failure.role}</code>: {failure.message}</div>
          ))}
        />
      )}

      {columns.length > 0 && (
        <div className="we-permissions-matrix-scroll">
          <table className="we-permissions-matrix" aria-labelledby="permissions-heading" data-testid="permissions-matrix">
            <thead>
              <tr>
                <th scope="col">{t("permissions.group")}</th>
                <th scope="col" className="we-permissions-matrix__key">{t("permissions.permission")}</th>
                {columns.map((role) => (
                  <th key={role.name} scope="col" data-testid={`permissions-role-${role.name}`}>
                    <div className="we-permissions-matrix__role">
                      <code>{role.name}</code>
                      {!role.isBuiltin && <span>{t("permissions.custom", { base: role.inheritsFrom })}</span>}
                      {role.isBuiltin && role.id && <span className="we-pill" data-tone="info">{t("permissions.override")}</span>}
                      <span>{t("permissions.summary", { granted: grantsOf(role).size, total: catalog.length })}</span>
                      {role.description && <span className="we-permissions-matrix__description" title={role.description}>{role.description}</span>}
                      {canWrite && role.isBuiltin && role.id && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => revertBuiltin(role)}
                          disabled={saving}
                          aria-label={t("permissions.revertAria", { role: role.name })}
                          title={t("permissions.revertAria", { role: role.name })}
                          leadingIcon={<RotateCcw size={14} />}
                          data-testid={`permissions-revert-${role.name}`}
                        />
                      )}
                      {canWrite && !role.isBuiltin && (
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => deleteCustom(role)}
                          disabled={saving}
                          aria-label={t("permissions.deleteAria", { role: role.name })}
                          title={t("permissions.deleteAria", { role: role.name })}
                          leadingIcon={<Trash2 size={14} />}
                          data-testid={`permissions-delete-${role.name}`}
                        />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            {visibleGroups.map(([category, entries]) => (
              <tbody key={category}>
                {entries.map((entry, index) => (
                  <tr key={entry.key}>
                    {index === 0 && (
                      <th scope="rowgroup" rowSpan={entries.length} className="we-permissions-matrix__group">{category}</th>
                    )}
                    <th scope="row" className="we-permissions-matrix__key" title={entry.description}>{entry.key}</th>
                    {columns.map((role) => {
                      const isMandatory = role.isBuiltin && role.name === "admin" && mandatoryAdmin.includes(entry.key);
                      const checked = grantsOf(role).has(entry.key);
                      const changed = differsFromDefault(role, entry);
                      return (
                        <td
                          key={role.name}
                          data-changed={changed || undefined}
                          data-unsaved={checked !== savedGrants[role.name].has(entry.key) || undefined}
                        >
                          <label>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!canWrite || isMandatory || saving}
                              onChange={() => toggleGrant(role.name, entry.key)}
                              aria-label={t("permissions.entryAria", { role: role.name, key: entry.key })}
                              aria-description={changed ? t("permissions.changedNote") : undefined}
                              data-testid={`permissions-toggle-${role.name}-${entry.key}`}
                            />
                            {isMandatory && <span className="we-pill" data-tone="warning">{t("permissions.required")}</span>}
                          </label>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
            {visibleGroups.length === 0 && (
              <tbody>
                <tr>
                  <td colSpan={columns.length + 2} data-testid="permissions-no-match">{t("permissions.noMatch")}</td>
                </tr>
              </tbody>
            )}
          </table>
        </div>
      )}

      {canWrite && <details className="we-permissions-role-card">
        <summary data-testid="permissions-add-role"><h4>{t("permissions.add.heading")}</h4></summary>
        <p>{t("permissions.add.intro")}</p>
        <form className="ui-form-layout" onSubmit={createRole} noValidate>
          <FormGrid>
            <FormField
              id="new-role-name"
              label={t("permissions.add.name")}
              required
              error={newRoleNameInvalid ? (
                <><AlertCircle size={13} aria-hidden="true" /> {t("permissions.errorName")}</>
              ) : undefined}
            >
              {(controlProps) => (
                <input
                  {...controlProps}
                  type="text"
                  value={newRoleName}
                  onChange={(e) => setNewRoleName(e.target.value)}
                  placeholder={t("permissions.add.namePlaceholder")}
                  maxLength={32}
                  required
                />
              )}
            </FormField>
            <FormField id="new-role-inherits" label={t("permissions.add.inherits")}>
              {(controlProps) => (
                <select
                  {...controlProps}
                  value={newRoleInherits}
                  onChange={(e) => setNewRoleInherits(e.target.value as Role)}
                >
                  <option value="viewer">{t("permissions.add.inheritOption.viewer")}</option>
                  <option value="editor">{t("permissions.add.inheritOption.editor")}</option>
                  <option value="admin">{t("permissions.add.inheritOption.admin")}</option>
                </select>
              )}
            </FormField>
            <FormField id="new-role-description" label={t("permissions.add.description")}>
              {(controlProps) => (
                <input
                  {...controlProps}
                  type="text"
                  value={newRoleDescription}
                  onChange={(e) => setNewRoleDescription(e.target.value)}
                  maxLength={240}
                />
              )}
            </FormField>
          </FormGrid>
          <div className="we-permissions-role-summary">
            <strong>{t("permissions.add.permissions")}</strong>
            <span>{t("permissions.add.permissionSummary", { granted: newRolePermissions.size, total: catalog.length })}</span>
          </div>
          <div className="we-permissions-grid">
            {grouped.map(([category, entries]) => (
              <div key={category} className="we-permissions-grid__category">
                <strong>{category}</strong>
                {entries.map((entry) => (
                  <label key={entry.key} className="we-permissions-grid__entry">
                    <input
                      type="checkbox"
                      checked={newRolePermissions.has(entry.key)}
                      onChange={() => toggleNewRolePermission(entry.key)}
                      aria-label={t("permissions.add.entryAria", { key: entry.key })}
                    />
                    <span title={entry.description}>{entry.key}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          <FormActions>
            <Button
              type="submit"
              variant="primary"
              disabled={!canCreateRole}
              loading={creating}
              loadingLabel={t("permissions.add.creating")}
              leadingIcon={<Plus size={15} />}
            >
              {t("permissions.add.create")}
            </Button>
          </FormActions>
        </form>
      </details>}
    </section>
  );
}
