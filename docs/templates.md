# Templates and expressions

Janusly templates are deterministic data projection, not executable code.

```text
{{context.input.customerId}}
{{context.fetch.output.json.total}}
{{secret.billing_token}}
{{env.JANUSLY_CRED_PARTNER}}
```

Ordinary `context.*` paths read run input and completed task output.
`{{secret.NAME}}` resolves the run organization's credential of kind
`template_secret` whose name matches `NAME` ignoring case. The task fails with
`Missing secret` when no such credential exists, when it has expired, when two
names differ only by case, or when its value is shorter than four characters,
the length below which values are not redacted. Names starting with `JANUSLY_`
are reserved and always read as missing. A resolved value is redacted from
events, task state, run output and errors.

Every other kind, including `generic`, `github_token` and `postgres`, never
resolves here. Choosing `template_secret` is how an administrator lets any
workflow author send the value to a destination the author picks; integration
tools keep sending their own kinds only to their provider.

Environment references are restricted by the credential environment
policy. Reserved platform names read as unset rather than revealing whether a
secret exists; tenant-owned process values should use the `JANUSLY_CRED_`
prefix or an explicitly allowlisted ordinary variable.

Condition expressions support a bounded set of boolean, equality, ordered, and
membership operators. They do not execute functions or arbitrary code.

`templatePolicy: "strict"` fails a task when an ordinary path is unresolved.
The default policy records a bounded `template.unresolved_path` event and
returns an empty value. Stream values cannot be persisted or interpolated.
