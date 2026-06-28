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
  grantedPermissions: string[];
  isOverride: boolean;
};

const ROLE_ORDER: Role[] = ["viewer", "editor", "admin"];

/** Custom role names: lowercase alphanumerics plus `_`/`-`, 1–32 chars. Mirrors
 *  the server-side validation so the operator sees the rule before submitting. */
const ROLE_NAME_RE = /^[a-z0-9_-]{1,32}$/;

export function PermissionGrantsPanel() {
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
        setCatalog(c.catalog ?? []);
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
              next[role.name] = new Set(role.grantedPermissions);
            }
          }
          return next;
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : (t("permissions.errorLoad") as string));
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
      addToast(tApiError(err) || (t("permissions.errorSave") as string), "error");
    } finally {
      setSavingRole(null);
    }
  }

  async function revertBuiltin(role: RoleEntry) {
    if (!(await confirmDialog({ body: t("permissions.confirmRevert", { role: role.name }) as string, tone: "danger" }))) return;
    try {
      await api(`/org/roles/${encodeURIComponent(role.name)}`, { method: "DELETE" });
      addToast(t("permissions.toastReverted", { role: role.name }), "success");
      bumpPlatformVersion();
    } catch (err) {
      addToast(tApiError(err) || (t("permissions.errorRevert") as string), "error");
    }
  }

  async function deleteCustom(role: RoleEntry) {
    if (!(await confirmDialog({ body: t("permissions.confirmDelete", { role: role.name }) as string, tone: "danger" }))) return;
    try {
      await api(`/org/roles/${encodeURIComponent(role.name)}`, { method: "DELETE" });
      addToast(t("permissions.toastDeleted", { role: role.name }), "success");
      bumpPlatformVersion();
    } catch (err) {
      addToast(tApiError(err) || (t("permissions.errorDelete") as string), "error");
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
      setError(t("permissions.errorName") as string);
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
      setError(err instanceof Error ? err.message : (t("permissions.errorCreate") as string));
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
    <section className="we-budget-settings" aria-labelledby="permissions-heading">
      <header className="we-budget-settings__header">
        <KeyRound size={18} aria-hidden="true" />
        <h3 id="permissions-heading">{t("permissions.heading")}</h3>
      </header>

      {error && (
        <div className="we-budget-settings__error" role="alert">
          {error}
        </div>
      )}

      {[...builtins, ...customs].map((role) => {
        const isAdminBuiltin = role.isBuiltin && role.name === "admin";
        return (
          <article key={role.name} className="we-permissions-role-card">
            <header>
              <h4>
                <code>{role.name}</code>
                {role.isBuiltin ? <span> {t("permissions.builtin")}</span> : <span> {t("permissions.custom", { base: role.inheritsFrom })}</span>}
                {role.isOverride && <span className="we-pill we-pill--info"> {t("permissions.override")}</span>}
              </h4>
              {role.description && <p>{role.description}</p>}
            </header>
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
                          disabled={isMandatory}
                          onChange={() => toggleEditing(role.name, entry.key)}
                          aria-label={t("permissions.entryAria", { role: role.name, key: entry.key }) as string}
                        />
                        <span title={entry.description}>{entry.key}</span>
                        {isMandatory && <span className="we-pill we-pill--warn">{t("permissions.required")}</span>}
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
            <footer>
              <button
                type="button"
                className="we-button we-button--primary"
                onClick={() => saveRole(role)}
                disabled={savingRole === role.name}
              >
                <Save size={14} aria-hidden="true" /> {t("permissions.save")}
              </button>
              {role.isBuiltin && role.isOverride && (
                <button
                  type="button"
                  className="we-button we-button--ghost"
                  onClick={() => revertBuiltin(role)}
                >
                  <RotateCcw size={14} aria-hidden="true" /> {t("permissions.revert")}
                </button>
              )}
              {!role.isBuiltin && (
                <button
                  type="button"
                  className="we-button we-button--ghost"
                  onClick={() => deleteCustom(role)}
                  aria-label={t("permissions.deleteAria", { role: role.name }) as string}
                >
                  <Trash2 size={14} aria-hidden="true" /> {t("permissions.delete")}
                </button>
              )}
            </footer>
          </article>
        );
      })}

      <article className="we-permissions-role-card we-permissions-role-card--new">
        <header>
          <h4>{t("permissions.add.heading")}</h4>
          <p>{t("permissions.add.intro")}</p>
        </header>
        <form className="we-budget-settings__form" onSubmit={createRole} noValidate>
          <label className="we-field">
            <span className="we-field__label">{t("permissions.add.name")}</span>
            <input
              type="text"
              className="we-field__input"
              value={newRoleName}
              onChange={(e) => setNewRoleName(e.target.value)}
              placeholder={t("permissions.add.namePlaceholder") as string}
              maxLength={32}
              aria-invalid={newRoleNameInvalid}
              aria-describedby={newRoleNameInvalid ? "new-role-name-error" : undefined}
            />
            {newRoleNameInvalid && (
              <span id="new-role-name-error" className="helper-text helper-text--error" role="alert">
                <AlertCircle size={13} aria-hidden="true" /> {t("permissions.errorName")}
              </span>
            )}
          </label>
          <label className="we-field">
            <span className="we-field__label">{t("permissions.add.inherits")}</span>
            <select
              className="we-field__input"
              value={newRoleInherits}
              onChange={(e) => setNewRoleInherits(e.target.value as Role)}
            >
              <option value="viewer">{t("permissions.add.inheritOption.viewer")}</option>
              <option value="editor">{t("permissions.add.inheritOption.editor")}</option>
              <option value="admin">{t("permissions.add.inheritOption.admin")}</option>
            </select>
          </label>
          <label className="we-field">
            <span className="we-field__label">{t("permissions.add.description")}</span>
            <input
              type="text"
              className="we-field__input"
              value={newRoleDescription}
              onChange={(e) => setNewRoleDescription(e.target.value)}
              maxLength={240}
            />
          </label>
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
                      aria-label={t("permissions.add.entryAria", { key: entry.key }) as string}
                    />
                    <span title={entry.description}>{entry.key}</span>
                  </label>
                ))}
              </div>
            ))}
          </div>
          <button type="submit" className="we-button we-button--primary" disabled={!canCreateRole}>
            <Plus size={14} aria-hidden="true" /> {creating ? t("permissions.add.creating") : t("permissions.add.create")}
          </button>
        </form>
      </article>
    </section>
  );
}
