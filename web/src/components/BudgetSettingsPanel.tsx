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

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Coins, Info, Save, ShieldAlert } from "lucide-react";
import { api, contractApi } from "../api";
import { useWorkflowStore } from "../store";
import { tApiError, useT } from "../i18n";
import { Button } from "./ui/Button";
import { FormActions, FormField, FormSection } from "./ui/Form";
import { StatusSummary } from "./ui/StatusSummary";
import { parseOrgConfigEntries } from "../lib/org-config-model";

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

/** A monthly-budget input is invalid only when it has content that isn't a
 *  finite, non-negative number (empty = unset, treated as valid). Mirrors the
 *  guard the save handlers throw on, so the operator sees it before submit. */
function isMonthlyInvalid(value: string): boolean {
  if (value.trim() === "") return false;
  const n = Number(value);
  return !Number.isFinite(n) || n < 0;
}
/** A warn-percent input is invalid when it has content outside the 0–100
 *  integer range. */
function isWarnInvalid(value: string): boolean {
  if (value.trim() === "") return false;
  const n = Number(value);
  return !Number.isInteger(n) || n < 0 || n > 100;
}


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
        const byKey = new Map(parseOrgConfigEntries(payload).map((entry) => [entry.key, entry.value]));
        setForm({
          monthlyUsd: String(byKey.get(ORG_CONFIG_KEYS.monthlyUsd) ?? 0),
          warnPercent: String(byKey.get(ORG_CONFIG_KEYS.warnPercent) ?? 80),
          policy: byKey.get(ORG_CONFIG_KEYS.policy) === "block" ? "block" : "warn",
        });
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : (t("budget.errorLoad")));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [platformVersion, t]);

  // Load workflows for the per-workflow dropdown.
  useEffect(() => {
    let cancelled = false;
    contractApi('GET /workflows', "/workflows", undefined)
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
          const nextWarnPercent = typeof env.warningPercent === "number" && Number.isInteger(env.warningPercent)
            ? env.warningPercent
            : 80;
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
      if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0) throw new Error(t("budget.errorMonthly"));
      if (!Number.isInteger(warnPercent) || warnPercent < 0 || warnPercent > 100) {
        throw new Error(t("budget.errorWarn"));
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
      // Surface the failure inline only — the persistent form error below is
      // the single feedback channel here (no duplicate transient toast).
      const message = tApiError(err) || (t("budget.errorSave"));
      setError(message);
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
      if (!Number.isFinite(monthlyUsd) || monthlyUsd < 0) throw new Error(t("budget.errorMonthly"));
      if (!Number.isInteger(warnPercent) || warnPercent < 0 || warnPercent > 100) {
        throw new Error(t("budget.errorWarn"));
      }
      await api(`/workflows/${encodeURIComponent(selectedWorkflowId)}/budget`, {
        method: "POST",
        body: JSON.stringify({ monthlyUsd, warnPercent, policy: wfPolicy }),
      });
      setWfStatus("saved");
      addToast(t("budget.workflow.toastSaved"), "success");
      bumpPlatformVersion();
    } catch (err) {
      // Inline-only feedback (the per-workflow status line renders the error);
      // no duplicate transient toast.
      const message = tApiError(err) || (t("budget.errorSave"));
      setWfStatus(message);
    } finally {
      setWfSaving(false);
    }
  };

  const orgBudgetDisabled = useMemo(() => {
    return Number(form.monthlyUsd) === 0;
  }, [form.monthlyUsd]);
  const aboutSectionLabel = t("common.aboutSection");
  const budgetIntro = t("budget.intro");
  // Live field validation mirrors the save-handler guards so the operator sees
  // a bad value (and the disabled save) before the round-trip.
  const orgMonthlyInvalid = isMonthlyInvalid(form.monthlyUsd);
  const orgWarnInvalid = isWarnInvalid(form.warnPercent);
  const wfMonthlyInvalid = isMonthlyInvalid(wfMonthly);
  const wfWarnInvalid = isWarnInvalid(wfWarnPercent);

  return (
    <section className="we-card we-budget-settings" aria-labelledby="budget-settings-heading" data-testid="budget-settings-panel">
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
        <StatusSummary
          role="alert"
          tone="danger"
          icon={<AlertTriangle size={16} />}
          title={error}
        />
      )}

      <FormSection title={t("budget.org")} description={budgetIntro} disabled={loading || saving}>
        <FormField
          id="budget-org-monthly"
          label={t("budget.field.monthly")}
          hint={orgBudgetDisabled ? t("budget.field.monthlyHintOff") : t("budget.field.monthlyHintOn")}
          error={orgMonthlyInvalid ? t("budget.errorMonthly") : undefined}
        >
          {(controlProps) => (
            <input
              {...controlProps}
              type="number"
              min={0}
              step={0.01}
              value={form.monthlyUsd}
              onChange={(event) => setForm((prev) => ({ ...prev, monthlyUsd: event.target.value }))}
              data-testid="budget-org-monthly"
            />
          )}
        </FormField>
        <FormField
          id="budget-org-warn"
          label={t("budget.field.warn")}
          hint={t("budget.field.warnHint")}
          error={orgWarnInvalid ? t("budget.errorWarn") : undefined}
        >
          {(controlProps) => (
            <input
              {...controlProps}
              type="number"
              min={0}
              max={100}
              step={1}
              value={form.warnPercent}
              onChange={(event) => setForm((prev) => ({ ...prev, warnPercent: event.target.value }))}
              data-testid="budget-org-warn"
            />
          )}
        </FormField>
        <FormField id="budget-org-policy" label={t("budget.field.policy")}>
          {(controlProps) => (
            <select
              {...controlProps}
              value={form.policy}
              onChange={(event) => setForm((prev) => ({ ...prev, policy: event.target.value === "block" ? "block" : "warn" }))}
              data-testid="budget-org-policy"
            >
              <option value="warn">{t("budget.policy.warnLabel")}</option>
              <option value="block">{t("budget.policy.blockLabel")}</option>
            </select>
          )}
        </FormField>
        <FormActions>
          <Button
            variant="primary"
            onClick={saveOrgBudget}
            disabled={saving || loading || orgMonthlyInvalid || orgWarnInvalid}
            loading={saving}
            loadingLabel={t("budget.saving")}
            leadingIcon={<Save size={15} />}
            data-testid="budget-org-save"
          >
            {t("budget.action.saveOrg")}
          </Button>
        </FormActions>
      </FormSection>

      <FormSection title={t("budget.workflow.title")} disabled={workflows.length === 0 || wfSaving}>
        {workflows.length === 0 ? (
          <p className="helper-text">{t("budget.workflow.empty")}</p>
        ) : (
          <>
            <FormField
              id="budget-workflow-select"
              label={t("budget.workflow.label")}
              hint={wfExisting ? t("budget.workflow.current", { usd: wfExisting.monthlyUsd.toFixed(2) }) : undefined}
            >
              {(controlProps) => (
                <select
                  {...controlProps}
                  value={selectedWorkflowId}
                  onChange={(event) => setSelectedWorkflowId(event.target.value)}
                  data-testid="budget-workflow-select"
                >
                  <option value="">{t("budget.workflow.pick")}</option>
                  {workflows.map((wf) => (
                    <option key={wf.id} value={wf.id ?? ""}>{wf.name ?? wf.id}</option>
                  ))}
                </select>
              )}
            </FormField>
            <FormField
              id="budget-workflow-monthly"
              label={t("budget.field.monthly")}
              error={wfMonthlyInvalid ? t("budget.errorMonthly") : undefined}
            >
              {(controlProps) => (
                <input
                  {...controlProps}
                  type="number"
                  min={0}
                  step={0.01}
                  value={wfMonthly}
                  onChange={(event) => setWfMonthly(event.target.value)}
                  disabled={!selectedWorkflowId}
                  data-testid="budget-workflow-monthly"
                />
              )}
            </FormField>
            <FormField
              id="budget-workflow-warn"
              label={t("budget.field.warn")}
              error={wfWarnInvalid ? t("budget.errorWarn") : undefined}
            >
              {(controlProps) => (
                <input
                  {...controlProps}
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={wfWarnPercent}
                  onChange={(event) => setWfWarnPercent(event.target.value)}
                  disabled={!selectedWorkflowId}
                  data-testid="budget-workflow-warn"
                />
              )}
            </FormField>
            <FormField id="budget-workflow-policy" label={t("budget.field.policy")}>
              {(controlProps) => (
                <select
                  {...controlProps}
                  value={wfPolicy}
                  onChange={(event) => setWfPolicy(event.target.value === "block" ? "block" : "warn")}
                  disabled={!selectedWorkflowId}
                  data-testid="budget-workflow-policy"
                >
                  <option value="warn">{t("budget.policy.warnLabel")}</option>
                  <option value="block">{t("budget.policy.blockLabel")}</option>
                </select>
              )}
            </FormField>
            {wfStatus === "saved" && (
              <StatusSummary
                role="status"
                tone="success"
                icon={<CheckCircle2 size={16} />}
                title={t("budget.workflow.savedConfirm")}
              />
            )}
            {wfStatus && wfStatus !== "saved" && (
              <StatusSummary role="alert" tone="danger" icon={<ShieldAlert size={16} />} title={wfStatus} />
            )}
            <FormActions>
              <Button
                variant="primary"
                onClick={saveWorkflowBudget}
                disabled={!selectedWorkflowId || wfSaving || wfMonthlyInvalid || wfWarnInvalid}
                loading={wfSaving}
                loadingLabel={t("budget.saving")}
                leadingIcon={<Save size={15} />}
                data-testid="budget-workflow-save"
              >
                {t("budget.workflow.action")}
              </Button>
            </FormActions>
          </>
        )}
      </FormSection>
    </section>
  );
}
