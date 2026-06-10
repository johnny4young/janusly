/**
 * AI cost budget admin editor — mounted inside `OperationsPage`.
 *
 * Two stacked sections:
 *
 *   1. Org-wide budget — three fields (monthlyUsd, warnPercent, policy)
 *      written to `POST /org/config` for keys `ai.budgetMonthlyUsd`,
 *      `ai.budgetWarnPercent`, `ai.budgetExceededPolicy`.
 *   2. Per-workflow override — workflow dropdown + monthly USD + policy,
 *      written to `POST /workflows/:id/budget` (admin).
 *
 * Admin-only. Calls `bumpPlatformVersion()` after a successful save so
 * the Recovery Center Budget tile + Operations bar refetch via their existing
 * `platformVersion` deps.
 *
 * Used by `OperationsPage.tsx`.
 */

import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Coins, Info, Save, ShieldAlert } from "lucide-react";
import { api } from "../api";
import { useWorkflowStore } from "../store";
import { tApiError, useT } from "../i18n";

type OrgBudgetForm = {
  monthlyUsd: string;
  warnPercent: string;
  policy: "warn" | "block";
};

type WorkflowSummaryRow = {
  id?: string;
  name?: string;
};

const ORG_CONFIG_KEYS = {
  monthlyUsd: "ai.budgetMonthlyUsd",
  warnPercent: "ai.budgetWarnPercent",
  policy: "ai.budgetExceededPolicy",
} as const;

type OrgConfigEntry = {
  key: string;
  value: string | number | boolean;
  source: string;
  description?: string;
};

type WorkflowBudgetRow = {
  id: string;
  workflowId: string;
  monthlyUsd: number;
  warnPercent: number;
  policy: "warn" | "block";
};

export function BudgetSettingsPanel() {
  const { t } = useT();
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion);
  const addToast = useWorkflowStore((state) => state.addToast);
  const platformVersion = useWorkflowStore((state) => state.platformVersion);

  const [form, setForm] = useState<OrgBudgetForm>({ monthlyUsd: "0", warnPercent: "80", policy: "warn" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-workflow state
  const [workflows, setWorkflows] = useState<WorkflowSummaryRow[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [wfMonthly, setWfMonthly] = useState<string>("");
  const [wfPolicy, setWfPolicy] = useState<"warn" | "block">("warn");
  const [wfWarnPercent, setWfWarnPercent] = useState<string>("80");
  const [wfSaving, setWfSaving] = useState(false);
  const [wfStatus, setWfStatus] = useState<string | null>(null);
  const [wfExisting, setWfExisting] = useState<WorkflowBudgetRow | null>(null);

  // Load org config snapshot on mount + platformVersion ticks.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api("/org/config")
      .then((payload) => {
        if (cancelled) return;
        const maybeEnvelope = payload as { config?: unknown };
        const entries = (Array.isArray(payload)
          ? payload
          : Array.isArray(maybeEnvelope.config)
            ? maybeEnvelope.config
            : []) as OrgConfigEntry[];
        const byKey = new Map(entries.map((entry) => [entry.key, entry.value]));
        setForm({
          monthlyUsd: String(byKey.get(ORG_CONFIG_KEYS.monthlyUsd) ?? 0),
          warnPercent: String(byKey.get(ORG_CONFIG_KEYS.warnPercent) ?? 80),
          policy: byKey.get(ORG_CONFIG_KEYS.policy) === "block" ? "block" : "warn",
        });
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : (t("budget.errorLoad") as string));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [platformVersion, t]);

  // Load workflows for the per-workflow dropdown.
  useEffect(() => {
    let cancelled = false;
    api("/workflows")
      .then((payload) => {
        if (cancelled) return;
        const list = (Array.isArray(payload) ? payload : []) as WorkflowSummaryRow[];
        setWorkflows(list.filter((entry) => typeof entry.id === "string"));
      })
      .catch(() => {
        if (cancelled) return;
        setWorkflows([]);
      });
    return () => { cancelled = true; };
  }, [platformVersion]);

  // When the operator picks a workflow, load its existing budget (if any)
  // so the form starts from the current values.
  useEffect(() => {
    if (!selectedWorkflowId) {
      setWfExisting(null);
      setWfMonthly("");
      setWfWarnPercent("80");
      setWfPolicy("warn");
      return;
    }
    let cancelled = false;
    api(`/billing/budget?workflowId=${encodeURIComponent(selectedWorkflowId)}`)
      .then((envelope) => {
        if (cancelled) return;
        const env = envelope as {
          monthlyUsdLimit?: number | null;
          policy?: "warn" | "block";
          resolvedScope?: string;
          warningPercent?: number;
        };
        if (env.resolvedScope === "workflow" && typeof env.monthlyUsdLimit === "number") {
          const nextWarnPercent = Number.isInteger(env.warningPercent) ? env.warningPercent : 80;
          const nextPolicy = env.policy === "block" ? "block" : "warn";
          setWfExisting({
            id: selectedWorkflowId,
            workflowId: selectedWorkflowId,
            monthlyUsd: env.monthlyUsdLimit,
            warnPercent: nextWarnPercent,
            policy: nextPolicy,
          });
          setWfMonthly(String(env.monthlyUsdLimit));
          setWfWarnPercent(String(nextWarnPercent));
          setWfPolicy(nextPolicy);
        } else {
          setWfExisting(null);
          setWfMonthly("");
          setWfWarnPercent("80");
          setWfPolicy("warn");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setWfExisting(null);
      });
    return () => { cancelled = true; };
  }, [selectedWorkflowId]);

  const saveOrgBudget = async () => {
    setSaving(true);
    setError(null);
    try {
      const monthlyUsd = Number(form.monthlyUsd);
      const warnPercent = Number(form.warnPercent);
      if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0) throw new Error(t("budget.errorMonthly") as string);
      if (!Number.isInteger(warnPercent) || warnPercent < 0 || warnPercent > 100) {
        throw new Error(t("budget.errorWarn") as string);
      }
      await api("/org/config", {
        method: "POST",
        body: JSON.stringify({ key: ORG_CONFIG_KEYS.monthlyUsd, value: monthlyUsd }),
      });
      await api("/org/config", {
        method: "POST",
        body: JSON.stringify({ key: ORG_CONFIG_KEYS.warnPercent, value: warnPercent }),
      });
      await api("/org/config", {
        method: "POST",
        body: JSON.stringify({ key: ORG_CONFIG_KEYS.policy, value: form.policy }),
      });
      addToast(t("budget.toastOrgSaved"), "success");
      bumpPlatformVersion();
    } catch (err) {
      const message = tApiError(err) || (t("budget.errorSave") as string);
      setError(message);
      addToast(message, "error");
    } finally {
      setSaving(false);
    }
  };

  const saveWorkflowBudget = async () => {
    if (!selectedWorkflowId) return;
    setWfSaving(true);
    setWfStatus(null);
    try {
      const monthlyUsd = Number(wfMonthly);
      const warnPercent = Number(wfWarnPercent);
      if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0) throw new Error(t("budget.errorMonthly") as string);
      if (!Number.isInteger(warnPercent) || warnPercent < 0 || warnPercent > 100) {
        throw new Error(t("budget.errorWarn") as string);
      }
      await api(`/workflows/${encodeURIComponent(selectedWorkflowId)}/budget`, {
        method: "POST",
        body: JSON.stringify({ monthlyUsd, warnPercent, policy: wfPolicy }),
      });
      setWfStatus("saved");
      addToast(t("budget.workflow.toastSaved"), "success");
      bumpPlatformVersion();
    } catch (err) {
      const message = tApiError(err) || (t("budget.errorSave") as string);
      setWfStatus(message);
      addToast(message, "error");
    } finally {
      setWfSaving(false);
    }
  };

  const orgBudgetDisabled = useMemo(() => {
    return Number(form.monthlyUsd) === 0;
  }, [form.monthlyUsd]);
  const aboutSectionLabel = t("common.aboutSection") as string;
  const budgetIntro = t("budget.intro") as string;

  return (
    <section className="panel-card we-budget-settings" aria-labelledby="budget-settings-heading" data-testid="budget-settings-panel">
      <div className="we-budget-settings__head">
        <span className="we-budget-settings__icon" aria-hidden="true"><Coins size={18} /></span>
        <div>
          <div className="section-kicker">{t("budget.kicker")}</div>
          <div className="we-heading-with-info">
            <h2 id="budget-settings-heading">{t("budget.heading")}</h2>
            <span
              className="we-info-icon"
              role="img"
              aria-label={`${aboutSectionLabel}: ${budgetIntro}`}
              title={budgetIntro}
            >
              <Info size={14} aria-hidden="true" />
            </span>
          </div>
        </div>
      </div>

      {error && (
        <div className="run-input-form-error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <fieldset className="we-budget-settings__fields" disabled={loading || saving}>
        <legend className="section-kicker">{t("budget.org")}</legend>
        <label className="we-field">
          <span>{t("budget.field.monthly")}</span>
          <input
            type="number"
            min={0}
            step={0.01}
            value={form.monthlyUsd}
            onChange={(event) => setForm((prev) => ({ ...prev, monthlyUsd: event.target.value }))}
            data-testid="budget-org-monthly"
          />
          <small>{orgBudgetDisabled ? t("budget.field.monthlyHintOff") : t("budget.field.monthlyHintOn")}</small>
        </label>
        <label className="we-field">
          <span>{t("budget.field.warn")}</span>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={form.warnPercent}
            onChange={(event) => setForm((prev) => ({ ...prev, warnPercent: event.target.value }))}
            data-testid="budget-org-warn"
          />
          <small>{t("budget.field.warnHint")}</small>
        </label>
        <label className="we-field">
          <span>{t("budget.field.policy")}</span>
          <select
            value={form.policy}
            onChange={(event) => setForm((prev) => ({ ...prev, policy: event.target.value === "block" ? "block" : "warn" }))}
            data-testid="budget-org-policy"
          >
            <option value="warn">{t("budget.policy.warnLabel")}</option>
            <option value="block">{t("budget.policy.blockLabel")}</option>
          </select>
        </label>
        <div className="we-budget-settings__actions">
          <button
            type="button"
            className="command-button command-button-primary"
            onClick={saveOrgBudget}
            disabled={saving || loading}
            data-testid="budget-org-save"
          >
            <Save size={14} aria-hidden="true" />
            {saving ? t("budget.saving") : t("budget.action.saveOrg")}
          </button>
        </div>
      </fieldset>

      <fieldset className="we-budget-settings__fields" disabled={workflows.length === 0 || wfSaving}>
        <legend className="section-kicker">{t("budget.workflow.title")}</legend>
        {workflows.length === 0 ? (
          <p className="helper-text">{t("budget.workflow.empty")}</p>
        ) : (
          <>
            <label className="we-field">
              <span>{t("budget.workflow.label")}</span>
              <select
                value={selectedWorkflowId}
                onChange={(event) => setSelectedWorkflowId(event.target.value)}
                data-testid="budget-workflow-select"
              >
                <option value="">{t("budget.workflow.pick")}</option>
                {workflows.map((wf) => (
                  <option key={wf.id} value={wf.id ?? ""}>{wf.name ?? wf.id}</option>
                ))}
              </select>
              {wfExisting && (
                <small>{t("budget.workflow.current", { usd: wfExisting.monthlyUsd.toFixed(2) })}</small>
              )}
            </label>
            <label className="we-field">
              <span>{t("budget.field.monthly")}</span>
              <input
                type="number"
                min={0}
                step={0.01}
                value={wfMonthly}
                onChange={(event) => setWfMonthly(event.target.value)}
                disabled={!selectedWorkflowId}
                data-testid="budget-workflow-monthly"
              />
            </label>
            <label className="we-field">
              <span>{t("budget.field.warn")}</span>
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={wfWarnPercent}
                onChange={(event) => setWfWarnPercent(event.target.value)}
                disabled={!selectedWorkflowId}
                data-testid="budget-workflow-warn"
              />
            </label>
            <label className="we-field">
              <span>{t("budget.field.policy")}</span>
              <select
                value={wfPolicy}
                onChange={(event) => setWfPolicy(event.target.value === "block" ? "block" : "warn")}
                disabled={!selectedWorkflowId}
                data-testid="budget-workflow-policy"
              >
                <option value="warn">{t("budget.policy.warnLabel")}</option>
                <option value="block">{t("budget.policy.blockLabel")}</option>
              </select>
            </label>
            {wfStatus === "saved" && (
              <div className="run-input-form-success" role="status">
                <CheckCircle2 size={14} aria-hidden="true" />
                <span>{t("budget.workflow.savedConfirm")}</span>
              </div>
            )}
            {wfStatus && wfStatus !== "saved" && (
              <div className="run-input-form-error" role="alert">
                <ShieldAlert size={14} aria-hidden="true" />
                <span>{wfStatus}</span>
              </div>
            )}
            <div className="we-budget-settings__actions">
              <button
                type="button"
                className="command-button command-button-primary"
                onClick={saveWorkflowBudget}
                disabled={!selectedWorkflowId || wfSaving}
                data-testid="budget-workflow-save"
              >
                <Save size={14} aria-hidden="true" />
                {wfSaving ? t("budget.saving") : t("budget.workflow.action")}
              </button>
            </div>
          </>
        )}
      </fieldset>
    </section>
  );
}
