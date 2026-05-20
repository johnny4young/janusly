# Janusly brand narrative

The single source of truth for how Janusly sounds when we talk about ourselves. Marketers, founders, and anyone pitching Janusly should lift sections from here verbatim instead of inventing new copy.

This is the **brand-voice register** of what `README.md` and [`docs/PLAN.md` §16.0](../PLAN.md) say in the technical and strategic registers. Same product. Same anchors. Different audience.

## Category

**Self-healing AI workflow operator.**

Janusly is not another automation builder. It is the **operating layer** for AI workflows in production — the place where a workflow that fails at 3am gets explained, recovered, reviewed, and replayed without paging anyone. Same surface area as a database administrator, but for the AI-driven business processes that increasingly run a company.

## Primary tagline

> **AI workflows that explain, recover, and safely evolve.**

Alt taglines, by context:

- **Landing hero:** *"The operational backbone for AI workflows."* — Punchy, category-defining, one line.
- **Sales call open:** *"Trust AI workflows in production — observable, recoverable, reviewable, auditable."* — The elevator. Lands the anchor phrase the buyer remembers.
- **Conference badge / podcast intro:** *"We make AI workflows feel less like fragile demos and more like production infrastructure."* — Names the pain the audience has felt.
- **Demo deck closer:** *"Mean Time To Recovery: from hours to minutes, from minutes to seconds."* — The metric, said plainly.

## One-sentence pitch

> **Trust AI workflows in production** — observable, recoverable, reviewable, auditable. Janusly is the operating layer for the AI-driven business processes that matter.

If you have ten seconds, this is the line.

## Anti-positioning

We are deliberate about what we are **not** because the workflow-automation category is crowded and confused. Saying "not Zapier" up front saves the buyer five minutes of mental sorting.

- **Not a "better Zapier UI."** Recovery, not integration breadth, is the wedge. Zapier wins when the question is "how many SaaS apps can I connect?" Janusly wins when the question is "what do I do when one of them breaks at 3am?"
- **Not "n8n with AI."** AI is part of the engine — the patch-suggestion path, the explain-run path, the multi-agent primitive — not a button glued on top of a visual builder.
- **Not generic RPA.** We operate AI workflows. We do not click-record desktop scripts. The runtime is a DAG, not a screen-recorder.
- **Not "agents that do everything."** Human approval gates and the recovery dialog are first-class primitives. The operator stays in the loop. The AI proposes; the human decides.

Anti-positioning is not snark. It is **respect for the buyer's time** — we tell them quickly what we are not, so they can decide just as quickly whether we are what they need.

## Product principles

The bets the product is built on, in brand voice. Each one names what the operator sees, not the route path behind it.

- **Observe every run.** A workflow should leave enough structured evidence for any operator to understand what happened — when, where, by whom, with what input, in what duration, with what cost. We treat the run timeline + audit log as first-class product surfaces, not engineering exhaust.
- **Explain every failure.** A failed step should produce a clear root cause, an owner, and a recovery path. The system speaks plain English about what broke and what to try next — no log archaeology required.
- **Recover safely.** AI can suggest the fix, but production changes must be **reviewable, sandboxed, auditable, and reversible**. Every patch is a proposal the operator reviews and applies; the sandbox proves the patch works before it touches real systems; the new version saves; the old version is one click away.
- **Improve over time.** Every accepted or rejected fix should teach the operator loop how *this* business wants to run. The product learns the team's tolerance for risk, their preferred recovery patterns, their MTTR baseline — and the recommendations adapt.

These are the four ways Janusly earns the right to be the platform you put critical AI workflows on top of. **Observable, recoverable, reviewable** is the three-word version we repeat.

## Demo story (the 3am moment)

It's 3am. The on-call engineer's phone buzzes. The billing flow has failed — the third one this week.

They open their laptop, expecting the usual ritual: log into the dashboard, dig through stack traces, find the broken step, ping the platform team, file a ticket, hope to get back to sleep by 4. Half an hour, minimum. Maybe an hour.

Tonight, the dashboard is Janusly. They see the failed run at the top of the Recovery Queue. They click into it. The system has already written, in plain English, what went wrong: *"The billing API call failed because the BILLING_API_KEY secret is unbound for this org. The call is also write-side and has no human approval gate upstream — which is why this kind of failure should not have been able to silently happen in the first place."*

The engineer reads two suggestions. The first is structural — insert an approval node before the billing call so this can't fire blindly again. The second is the immediate fix — swap the secret to the one the operator already has bound. They click **Apply & validate**. Janusly runs the patched workflow in a sandbox, without touching the real billing system, and confirms it would have worked. They click apply, approve the held run, and watch it run through to green.

It's 3:04am. The engineer goes back to sleep.

This is what we mean by self-healing. Not "the AI fixes it without you." But "the system makes the fix you'd have made anyway, and shows you the work, in three minutes instead of an hour." The human is still in the loop — they read, they decide, they apply. Janusly removes the toil between the alert and the green replay.

## Brand voice notes

For anyone writing new Janusly copy — landing pages, decks, social posts, sales emails — these are the rules that keep us in voice:

- **Concrete over abstract.** A scene ("3am, billing flow, credential rotated") lands harder than a claim ("we enable resilient AI workflows"). When in doubt, write the scene.
- **Honest about today vs. destination.** Janusly is **being built**. We say what ships today (Recovery Center, patch suggestions, sandbox validation, version rollback) and what is the direction (the operational backbone for every AI workflow that matters). Conflating the two erodes trust.
- **Engineering reality as proof.** Every brand claim should be cashable in a route path, a table name, a feature already shipped. If a marketing line can't be backed by something a developer could point at, it is fluff. Cut it.
- **Never "AI fixes everything."** The human is in the loop. The AI proposes; the operator decides. Any line that suggests Janusly is a magic auto-fix is wrong about both the product and the position. Catch this and rewrite.
- **MTTR is the metric of record.** When we name a number, it's Mean Time To Recovery for failed automations. Other metrics are interesting; MTTR is the one we own.
- **Anti-positioning earns trust.** Saying what we are not (Zapier, n8n, RPA, agents-that-do-everything) is not a put-down — it is respect for the buyer who has seen all four. Keep it crisp, never snarky.

When you draft new copy, run it past this list. If any line breaks one of these rules, rewrite it before publishing.

---

## Versión en español

La versión paralela en castellano. Misma estructura, mismos anclas, misma engineering reality. Las rutas (`POST /ai/explain-run`, `POST /ai/patch-workflow`) y las tablas (`audit_logs`, `dead_letters`, `run_events`, `usage_events`) quedan en inglés en ambos idiomas porque son identificadores de código, no texto traducible. El brand-mark "Janusly" tampoco se traduce.

Vocabulario canónico, lifted de [`landing-page.md`](landing-page.md) Section E: `autoreparable` (no `autocurativo`), `Centro de Recuperación` (no `Hub de Recuperación`), `flujo` / `flujo de trabajo` (no `workflow`), `operador` (no `automatizador`). Quedan en inglés porque son anglicismos técnicos aceptados: `sandbox`, `rollback`, `DAG`, `MTTR`, `self-host`. Tono: `tú` informal, nunca `usted`.

### Categoría

**Operador autoreparable de flujos AI.**

Janusly no es otro builder de automatizaciones. Es la **capa operativa** para flujos AI en producción — el lugar donde un flujo que falla a las 3am se explica, se recupera, se revisa y se reproduce sin tener que paginar a nadie. La misma superficie operativa que un administrador de base de datos, pero para los procesos de negocio AI-driven que cada vez más corren una compañía.

### Tagline principal

> **Flujos AI que explican, recuperan y evolucionan con seguridad.**

Taglines alternativos, por contexto:

- **Hero del landing:** *"La capa operativa para flujos AI."* — Directo, define la categoría, una línea.
- **Apertura de llamada de ventas:** *"Confía en tus flujos AI en producción — observables, recuperables, revisables, auditables."* — El elevator. Deja la frase ancla que el comprador recuerda.
- **Badge de conferencia / intro de podcast:** *"Hacemos que los flujos AI dejen de sentirse como demos frágiles y empiecen a sentirse como infraestructura de producción."* — Nombra el dolor que la audiencia ya sintió.
- **Cierre del demo deck:** *"Tiempo Medio de Recuperación (MTTR): de horas a minutos, de minutos a segundos."* — La métrica, dicha sin adornos.

### Pitch de una oración

> **Confía en tus flujos AI en producción** — observables, recuperables, revisables, auditables. Janusly es la capa operativa de los procesos de negocio AI-driven que importan.

Si tienes diez segundos, esta es la línea.

### Anti-posicionamiento

Somos deliberados sobre lo que **no somos** porque la categoría de automatización de flujos está saturada y confundida. Decir "no Zapier" desde el principio le ahorra al comprador cinco minutos de ordenamiento mental.

- **No "una mejor UI de Zapier".** La recuperación, no la cantidad de integraciones, es la cuña. Zapier gana cuando la pregunta es "¿cuántas apps SaaS puedo conectar?" Janusly gana cuando la pregunta es "¿qué hago cuando una de ellas se rompe a las 3am?"
- **No "n8n con AI".** La AI es parte del engine — el path de patch-suggestion, el path de explain-run, el primitivo multi-agent — no un botón pegado encima de un visual builder.
- **No RPA genérico.** Operamos flujos AI. No grabamos clicks en scripts de UI de escritorio. El runtime es un DAG, no un grabador de pantalla.
- **No "agentes que hacen todo".** Las puertas de aprobación humana y el diálogo de recuperación son primitivos de primera clase. El operador queda en el loop. La AI propone; el humano decide.

El anti-posicionamiento no es sarcasmo. Es **respeto por el tiempo del comprador** — le decimos rápido lo que no somos, así puede decidir igual de rápido si somos lo que necesita.

### Principios de producto

Las apuestas sobre las que está construido el producto, en la voz de marca. Cada una nombra lo que el operador ve, no la ruta de código que la respalda.

- **Observa cada run.** Un flujo debería dejar suficiente evidencia estructurada para que cualquier operador entienda qué pasó — cuándo, dónde, por quién, con qué input, en qué duración, a qué costo. Tratamos el timeline del run + el audit log como superficies de primera clase del producto, no como exhaust de ingeniería.
- **Explica cada falla.** Un paso fallido debería producir una causa raíz clara, un dueño, y un camino de recuperación. El sistema habla en castellano simple sobre qué se rompió y qué intentar después — sin arqueología de logs.
- **Recupera de forma segura.** La AI puede sugerir el fix, pero los cambios en producción tienen que ser **revisables, sandboxeados, auditables y reversibles**. Cada parche es una propuesta que el operador revisa y aplica; el sandbox prueba que el parche funciona antes de tocar sistemas reales; la nueva versión se guarda; la versión anterior está a un click.
- **Mejora con el tiempo.** Cada fix aceptado o rechazado debería enseñarle al loop del operador cómo *este* negocio quiere correr. El producto aprende la tolerancia al riesgo del equipo, sus patrones de recuperación preferidos, su baseline de MTTR — y las recomendaciones se adaptan.

Estas son las cuatro formas en que Janusly se gana el derecho a ser la plataforma sobre la que pones flujos AI críticos. **Observable, explicable, revisable** es la versión de tres palabras que repetimos.

### La historia del demo (las 3am)

Son las 3am. Le suena el teléfono al ingeniero de guardia. El flujo de billing falló — el tercero de esta semana.

Abre la laptop, esperando el ritual de siempre: entrar al dashboard, escarbar entre stack traces, encontrar el paso roto, pinguear al equipo de plataforma, abrir un ticket, esperar volver a dormir antes de las 4. Media hora, mínimo. Tal vez una hora.

Esta noche, el dashboard es Janusly. Ve el run fallido al tope del Centro de Recuperación. Hace click. El sistema ya escribió, en castellano simple, qué salió mal: *"El call a la API de billing falló porque el secret `BILLING_API_KEY` no está bindeado para este org. El call también es write-side y no tiene una puerta de aprobación humana arriba — que es por qué este tipo de falla no debería haber podido pasar en silencio."*

El ingeniero lee dos sugerencias. La primera es estructural — insertar un nodo de aprobación antes del call de billing para que esto no vuelva a dispararse a ciegas. La segunda es el fix inmediato — swap del secret al que el operador ya tiene bindeado. Hace click en **Apply & validate** (el botón se ve en español como *"Aplicar y validar"* — la UI ya está traducida). Janusly corre el flujo parcheado en un sandbox, sin tocar el sistema real de billing, y confirma que habría funcionado. Hace click en aplicar, aprueba el run en espera, y mira cómo corre hasta verde.

Son las 3:04am. El ingeniero vuelve a dormir.

Esto es lo que significa autoreparable. No "la AI lo arregla sin ti". Sino "el sistema hace el fix que tú habrías hecho de todos modos, y te muestra el trabajo, en tres minutos en lugar de una hora". El humano sigue en el loop — lee, decide, aplica. Janusly remueve el toil entre la alerta y el green replay.

### Notas de voz de marca

Para cualquiera que esté escribiendo nuevo copy de Janusly — landing pages, decks, posts en redes, emails de ventas — estas son las reglas que nos mantienen en voz:

- **Concreto sobre abstracto.** Una escena ("3am, flujo de billing, credencial rotada") aterriza mejor que un claim ("habilitamos flujos AI resilientes"). Cuando dudes, escribe la escena.
- **Honestos sobre hoy vs destino.** Janusly **está siendo construido**. Decimos qué ship hoy (Centro de Recuperación, sugerencias de parche, validación en sandbox, version rollback) y qué es la dirección (la columna operativa de cada flujo AI que importa). Confundir ambas cosas erosiona la confianza.
- **Engineering reality como prueba.** Cada claim de marca debería poder cobrarse en un path de ruta, un nombre de tabla, una feature ya shipped. Si una línea de marketing no se puede respaldar con algo que un developer puede señalar, es relleno. Sácala.
- **Nunca "la AI lo arregla todo".** El humano está en el loop. La AI propone; el operador decide. Cualquier línea que sugiera que Janusly es un auto-fix mágico está equivocada sobre el producto y sobre el posicionamiento. Detéctala y reescríbela.
- **MTTR es la métrica de récord.** Cuando nombramos un número, es Tiempo Medio de Recuperación (MTTR) de automatizaciones fallidas. Otras métricas son interesantes; MTTR es la que medimos.
- **El anti-posicionamiento se gana la confianza.** Decir lo que no somos (Zapier, n8n, RPA, agentes-que-hacen-todo) no es un golpe — es respeto al comprador que ya vio los cuatro. Mantenlo claro, nunca chistoso.

Cuando redactes nuevo copy, pásalo por esta lista. Si alguna línea rompe alguna de estas reglas, reescríbela antes de publicar.
