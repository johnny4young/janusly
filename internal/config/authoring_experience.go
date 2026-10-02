package config

import (
	"errors"
	"strings"
)

// AuthoringExperienceMode controls optional proposal selection, independently
// of the registry's opt-in gate. No mode grants provider or execution authority.
type AuthoringExperienceMode string

const (
	AuthoringExperienceOff    AuthoringExperienceMode = "off"
	AuthoringExperienceShadow AuthoringExperienceMode = "shadow"
	AuthoringExperienceReview AuthoringExperienceMode = "review"
)

func ResolveAuthoringExperienceMode(raw string) (AuthoringExperienceMode, error) {
	switch mode := AuthoringExperienceMode(strings.TrimSpace(raw)); mode {
	case "", AuthoringExperienceOff:
		return AuthoringExperienceOff, nil
	case AuthoringExperienceShadow, AuthoringExperienceReview:
		return mode, nil
	default:
		return AuthoringExperienceOff, errors.New("JANUSLY_AUTHORING_EXPERIENCE_MODE must be off, shadow or review")
	}
}
