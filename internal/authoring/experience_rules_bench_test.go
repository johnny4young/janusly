package authoring

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func BenchmarkRulesDecisionBoundedProjection(b *testing.B) {
	for _, count := range []int{0, 1, MaxExperienceCandidates} {
		b.Run(fmt.Sprintf("candidates=%d", count), func(b *testing.B) {
			brief := IntentBrief{Version: "1", Objective: "Prepare local text", Trigger: "manual", Inputs: []string{}, ExpectedOutcome: "Local text", ExternalEffects: []string{}, Approvals: []string{}, FailurePolicy: "stop_and_open_recovery_case", Examples: []string{}, Language: "en"}
			key, err := CanonicalExperienceKey(brief)
			if err != nil {
				b.Fatal(err)
			}
			now := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
			request := DecisionRequest{OrganizationID: "org", ContextRevision: "rev", CatalogVersion: "catalog", Brief: brief, Complete: true, Consent: true, AsOf: now}
			for i := range count {
				request.Candidates = append(request.Candidates, ExperienceCandidate{ID: fmt.Sprintf("exp-%d", i), OrganizationID: "org", WorkflowID: "workflow", VersionID: fmt.Sprintf("version-%d", i), Version: i + 1, BriefKey: key, PolicyVersion: AuthoringExperiencePolicyVersion, RegisteredAt: now, VersionCreatedAt: now, RetainUntil: now.Add(time.Hour), Readable: true, Compatible: true})
			}
			ctx := context.Background()
			b.ReportAllocs()
			for b.Loop() {
				if _, err := ProposeDecision(ctx, RulesProvider{}, request); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
