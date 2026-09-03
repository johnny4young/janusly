/**
 * Permission grants admin panel — mounted inside `OperationsPage`.
 *
 * Renders the closed permission catalog as a checkbox grid grouped by
 * category, with one card per role (built-ins first, custom roles
 * after). Admins can:
 *
 *   - Override a built-in role's permission set (or revert to
 *     catalog defaults).
 *   - Create a custom role (`compliance`, `ops-readonly`, …) with
 *     `inheritsFrom` rank inheritance + an explicit permission set.
 *   - Edit / delete custom roles (built-ins can't be deleted).
 *
 * Admin-only. Calls `bumpPlatformVersion()` after a successful save so
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
import { FormActions, FormField, FormGrid } from "./ui/Form";
import { StatusSummary } from "./ui/StatusSummary";

type Role = "viewer" | "editor" | "admin";

type CatalogEntry = {
  key: string;
  category: string;
  description: string;
  defaultRoles: readonly Role[];
};

type RoleEntry = {
  name: string;
  isBuiltin: boolean;
  inheritsFrom: Role;
  description: string | null;
  grantedPermissions: string[] | null;
  isOverride?: boolean;
};

const ROLE_ORDER: Role[] = ["viewer", "editor", "admin"];

/** Custom role names: lowercase alphanumerics plus `_`/`-`, 1–32 chars. Mirrors
 *  the server-side validation so the operator sees the rule before submitting. */
const ROLE_NAME_RE = /^[a-z0-9_-]{1,32}$/;

export function PermissionGrantsPanel({ canWrite = true }: { canWrite?: boolean } = {}) {
  const { t } = useT();
  const confirmDialog = useConfirm();
  const bumpPlatformVersion = useWorkflowStore((s) => s.bumpPlatformVersion);
  const addToast = useWorkflowStore((s) => s.addToast);
  const platformVersion = useWorkflowStore((s) => s.platformVersion);

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

  // Per-role dirty checkbox state for editing
  const [editing, setEditing] = useState<Record<string, Set<string>>>({});
  const [savingRole, setSavingRole] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([api("/org/permissions/catalog"), api("/org/roles")])
      .then(([catalogResp, rolesResp]) => {
        if (cancelled) return;
        const c = (catalogResp as { catalog?: CatalogEntry[]; mandatoryAdminPermissions?: string[] }) ?? {};
        const catalogEntries = c.catalog ?? [];
        setCatalog(catalogEntries);
        setMandatoryAdmin(c.mandatoryAdminPermissions ?? []);
        const r = (rolesResp as { roles?: RoleEntry[] }) ?? {};
        setRoles(r.roles ?? []);
        // Only seed `editing` for roles we haven't touched yet — refetches
        // from a platformVersion bump must NOT clobber an admin's in-progress
        // edits on roles they haven't saved yet. New roles that appeared in
        // the server response (e.g. someone else created a custom role)
        // still get their default initial state.
        setEditing((prev) => {
          const next: Record<string, Set<string>> = { ...prev };
          for (const role of r.roles ?? []) {
            if (!(role.name in next)) {
              const granted = Array.isArray(role.grantedPermissions)
                ? role.grantedPermissions
                : role.isBuiltin
                  ? catalogEntries
                    .filter((entry) => entry.defaultRoles.includes(role.name as Role))
                    .map((entry) => entry.key)
                  : [];
              next[role.name] = new Set(granted);
            }
          }
          return next;
        });
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
  }, [platformVersion, t]);

  const grouped = useMemo(() => {
    const out = new Map<string, CatalogEntry[]>();
    for (const e of catalog) {
      const list = out.get(e.category) ?? [];
      list.push(e);
      out.set(e.category, list);
    }
    return Array.from(out.entries());
  }, [catalog]);

  function toggleEditing(roleName: string, key: string) {
    setEditing((prev) => {
      const set = new Set(prev[roleName] ?? []);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      return { ...prev, [roleName]: set };
    });
  }

  async function saveRole(role: RoleEntry) {
    const granted = Array.from(editing[role.name] ?? new Set<string>()).sort();
    setSavingRole(role.name);
    try {
      await api(`/org/roles/${encodeURIComponent(role.name)}`, {
        method: "POST",
        body: JSON.stringify({ grantedPermissions: granted }),
      });
      addToast(t("permissions.toastUpdated", { role: role.name }), "success");
      bumpPlatformVersion();
    } catch (err) {
      addToast(tApiError(err) || (t("permissions.errorSave")), "error");
    } finally {
      setSavingRole(null);
    }
  }

  async function revertBuiltin(role: RoleEntry) {
    if (!(await confirmDialog({ body: t("permissions.confirmRevert", { role: role.name }), tone: "danger" }))) return;
    try {
      await api(`/org/roles/${encodeURIComponent(role.name)}`, { method: "DELETE" });
      addToast(t("permissions.toastReverted", { role: role.name }), "success");
      bumpPlatformVersion();
    } catch (err) {
      addToast(tApiError(err) || (t("permissions.errorRevert")), "error");
    }
  }

  async function deleteCustom(role: RoleEntry) {
    if (!(await confirmDialog({ body: t("permissions.confirmDelete", { role: role.name }), tone: "danger" }))) return;
    try {
      await api(`/org/roles/${encodeURIComponent(role.name)}`, { method: "DELETE" });
      addToast(t("permissions.toastDeleted", { role: role.name }), "success");
      bumpPlatformVersion();
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
      bumpPlatformVersion();
    } catch (err) {
      setError(err instanceof Error ? err.message : (t("permissions.errorCreate")));
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
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

  // Live validation for the new-role name: flag a non-empty value that breaks
  // the format so the operator sees it before submitting, and gate the submit.
  const trimmedNewRoleName = newRoleName.trim().toLowerCase();
  const newRoleNameInvalid = trimmedNewRoleName.length > 0 && !ROLE_NAME_RE.test(trimmedNewRoleName);
  const canCreateRole = trimmedNewRoleName.length > 0 && !newRoleNameInvalid && !creating;

  return (
    <section className="we-budget-settings" aria-labelledby="permissions-heading" data-testid="permission-grants-panel">
      <header className="we-budget-settings__header">
        <KeyRound size={18} aria-hidden="true" />
        <h3 id="permissions-heading">{t("permissions.heading")}</h3>
      </header>

      {error && (
        <StatusSummary role="alert" tone="danger" icon={<AlertCircle size={16} />} title={error} />
      )}

      {[...builtins, ...customs].map((role) => {
        const isAdminBuiltin = role.isBuiltin && role.name === "admin";
        const grantedCount = editing[role.name]?.size ?? 0;
        return (
          <article
            key={role.name}
            className="we-permissions-role-card"
            data-testid={`permissions-role-${role.name}`}
          >
            <header>
              <h4>
                <code>{role.name}</code>
                {role.isBuiltin ? <span> {t("permissions.builtin")}</span> : <span> {t("permissions.custom", { base: role.inheritsFrom })}</span>}
                {role.isOverride && <span className="we-pill" data-tone="info"> {t("permissions.override")}</span>}
              </h4>
              {role.description && <p>{role.description}</p>}
            </header>
            <div className="we-permissions-role-summary">
              <span className="mode-pill mode-pill-neutral">
                {t("permissions.summary", { granted: grantedCount, total: catalog.length })}
              </span>
              <span>
                {role.isBuiltin
                  ? t("permissions.summaryBuiltin")
                  : t("permissions.summaryCustom", { base: role.inheritsFrom })}
              </span>
            </div>
            <div className="we-permissions-grid">
              {grouped.map(([category, entries]) => (
                <div key={category} className="we-permissions-grid__category">
                  <strong>{category}</strong>
                  {entries.map((entry) => {
                    const isMandatory = isAdminBuiltin && mandatoryAdmin.includes(entry.key);
                    const checked = editing[role.name]?.has(entry.key) ?? false;
                    return (
                      <label key={entry.key} className="we-permissions-grid__entry">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!canWrite || isMandatory}
                          onChange={() => toggleEditing(role.name, entry.key)}
                          aria-label={t("permissions.entryAria", { role: role.name, key: entry.key })}
                        />
                        <span title={entry.description}>{entry.key}</span>
                        {isMandatory && <span className="we-pill" data-tone="warning">{t("permissions.required")}</span>}
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
            <footer>
              <Button
                size="sm"
                variant="primary"
                onClick={() => saveRole(role)}
                disabled={!canWrite || savingRole === role.name}
                loading={savingRole === role.name}
                loadingLabel={t("permissions.save")}
                leadingIcon={<Save size={14} />}
              >
                {t("permissions.save")}
              </Button>
              {role.isBuiltin && role.isOverride && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => revertBuiltin(role)}
                  disabled={!canWrite}
                  leadingIcon={<RotateCcw size={14} />}
                >
                  {t("permissions.revert")}
                </Button>
              )}
              {!role.isBuiltin && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => deleteCustom(role)}
                  disabled={!canWrite}
                  aria-label={t("permissions.deleteAria", { role: role.name })}
                  leadingIcon={<Trash2 size={14} />}
                >
                  {t("permissions.delete")}
                </Button>
              )}
            </footer>
          </article>
        );
      })}

      {canWrite && <article className="we-permissions-role-card we-permissions-role-card--new">
        <header>
          <h4>{t("permissions.add.heading")}</h4>
          <p>{t("permissions.add.intro")}</p>
        </header>
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
      </article>}
    </section>
  );
}
