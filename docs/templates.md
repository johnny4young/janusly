# Templates and expressions

Janusly templates are deterministic data projection, not executable code.

```text
{{context.input.customerId}}
{{context.fetch.output.json.total}}
{{secret.billing_token}}
{{env.JANUSLY_CRED_PARTNER}}
```

Ordinary `context.*` paths read run input and completed task output. Secret
references resolve through the organization credential boundary and fail when
missing. Environment references are restricted by the credential environment
policy.

Condition expressions support a bounded set of boolean, equality, ordered, and
membership operators. They do not execute functions or arbitrary code.

`templatePolicy: "strict"` fails a task when an ordinary path is unresolved.
The default policy records a bounded `template.unresolved_path` event and
returns an empty value. Stream values cannot be persisted or interpolated.
