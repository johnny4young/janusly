import type { Dictionary } from './en';

export const es: Dictionary = {
  meta: {
    title: 'Janusly — El operador de IA para tus workflows de negocio',
    description:
      'Diseña workflows con IA, ejecútalos sobre una cola durable en PostgreSQL y recupera fallos con la evidencia adjunta. Un solo ejecutable en Go, en tu infraestructura.',
  },
  common: {
    languageSelect: 'Idioma',
    skipToContent: 'Ir al contenido',
    homeAria: 'Inicio de Janusly',
    primaryNav: 'Navegación principal',
    mobileNav: 'Navegación móvil',
    openMenu: 'Abrir menú',
    closeMenu: 'Cerrar menú',
    github: 'GitHub',
    getStarted: 'Empezar',
    seeRecoveryCenter: 'Ver el Recovery Center',
    readDocs: 'Leer la documentación',
    talkToUs: 'Hablemos',
  },
  nav: {
    why: 'Por qué Janusly',
    product: 'Producto',
    compare: 'Comparar',
    pricing: 'Precios',
    faq: 'Preguntas',
    docs: 'Docs',
  },
  hero: {
    pill: 'Self-hosted · un ejecutable · tu PostgreSQL',
    title: 'El operador de IA para tus workflows de negocio.',
    lede:
      'Janusly diseña los workflows contigo, los ejecuta sobre una cola durable y, cuando un paso falla, agrupa los fallos, los reintenta y te muestra la evidencia. Un solo binario en Go, en tu infraestructura.',
    note: 'Imagen Docker o un solo binario. PostgreSQL 18. Sin plano de control que alquilar.',
    screenshotAlt: 'Cola de recuperación de Janusly con dos fallos abiertos y uno seleccionado',
    caption: 'La cola de recuperación: cada paso fallido, agrupado por causa, a un clic del reintento.',
  },
  trust: {
    binary: 'Un ejecutable en Go',
    postgres: 'PostgreSQL como cola durable',
    mcp: 'Cliente y servidor MCP',
    otel: 'OpenTelemetry integrado',
    selfHosted: 'Self-hosted, las credenciales no salen',
  },
  why: {
    kicker: 'Por qué Janusly',
    title: 'Cuatro trabajos que casi todas las herramientas reparten en cuatro productos.',
    lede:
      'Diseñar, ejecutar, recuperar y operar viven en el mismo runtime: un fallo del martes es un cambio de workflow el miércoles, con la evidencia adjunta.',
    design: {
      title: 'Diseñar',
      body:
        'Describe el resultado. AI Studio compila un brief de intención en un workflow legible, con cada herramienta, credencial y aprobación nombrada antes de que algo corra.',
    },
    run: {
      title: 'Ejecutar',
      body:
        'Cada paso es una fila en tu PostgreSQL. Arranques idempotentes, workers acotados, despertares por LISTEN/NOTIFY y polling como respaldo: nada depende de un broker que haya que cuidar.',
    },
    recover: {
      title: 'Recuperar',
      body:
        'Los fallos se agrupan por causa. Reintenta uno, lanza una campaña sobre el grupo o deja que auto-healing proponga un arreglo validado primero en una muestra, con las escrituras externas suprimidas. Los contratos de recuperación traen fixtures que deben pasar antes de un rollout.',
    },
    operate: {
      title: 'Operar',
      body:
        'Presupuestos de IA por workflow, políticas de alertas, un circuit breaker que pausa cada punto de entrada hasta que reanudes, páginas de estado públicas, y métricas y trazas de serie.',
    },
  },
  product: {
    kicker: 'Producto',
    title: 'Lo que ve un operador en una mala mañana.',
    lede: 'Tres superficies, un runtime, sin diagramas: cada tarjeta es lo que el operador realmente toca.',
    tabs: { recovery: 'Recovery Center', studio: 'AI Studio', operations: 'Operaciones' },
    cluster: {
      kicker: 'Grupo de fallos',
      count: '14 ejecuciones',
      title: 'notify_owner · HTTP 429 de Slack',
      cause: 'Causa',
      causeValue: 'rate_limited',
      firstSeen: 'Primera vez',
      blast: 'Alcance',
      blastValue: '2 workflows',
      replay: 'Reintentar el grupo',
      open: 'Abrir caso',
    },
    healing: {
      kicker: 'Auto-healing',
      validated: 'Validado en 1 muestra',
      title: 'Agregar reintento con backoff antes de notify_owner',
      body: 'Propuesto desde la evidencia del grupo. Corre primero contra una muestra fallida; el resto se reintenta solo cuando pasa y tú apruebas.',
      approve: 'Aprobar y reintentar 13',
      reject: 'Rechazar',
    },
    operations: {
      kicker: 'Operaciones',
      window: 'últimas 24 h',
      queueLag: 'Latencia de cola p95',
      recovered: 'Ejecuciones recuperadas',
      spend: 'Gasto de IA',
      budgetLeft: 'Presupuesto restante',
      note: 'Scrape de Prometheus en :9464, trazas a tu collector de OpenTelemetry, políticas de alerta a Slack, correo o un webhook.',
    },
    sampleNote: 'Valores de muestra; las capturas por superficie llegan antes del lanzamiento.',
  },
  compare: {
    kicker: 'Comparar',
    title: 'Dónde queda frente a lo que quizá ya usas.',
    lede:
      'Las plataformas de integración arrancan rápido; los motores de workflows son durables; Janusly es el operador encima: durable, self-hosted y construido alrededor de la recuperación.',
    capability: 'Capacidad',
    columns: { janusly: 'Janusly', ipaas: 'iPaaS hospedado', lowcode: 'Automatización low-code', engine: 'Motor de workflows' },
    yes: 'Sí',
    no: 'No',
    rows: {
      selfHosted: { label: 'Self-hosted, un binario + PostgreSQL', engine: 'Clúster + servicios' },
      recovery: { label: 'Recuperación con evidencia (grupos, reintentos, auto-healing validado)', ipaas: 'Reintento manual', lowcode: 'Reintento manual', engine: 'Reintentos, sin operador' },
      operator: { label: 'Operador de IA: de un brief a un workflow legible', ipaas: 'Asistentes hospedados', lowcode: 'Nodos, no un operador' },
      mcp: { label: 'Cliente MCP y servidor MCP', ipaas: 'Solo cliente', lowcode: 'Solo cliente' },
      budgets: { label: 'Presupuestos de IA, métricas RED y trazas incluidas', ipaas: 'Cuotas de tareas', lowcode: 'Complementos', engine: 'Métricas, sin presupuestos' },
    },
    note: 'Categorías, no marcas.',
  },
  pricing: {
    kicker: 'Precios',
    title: 'Ejecútalo tú mismo gratis. Paga cuando nos quieras de guardia.',
    selfHosted: {
      name: 'Self-hosted',
      price: 'Gratis',
      tagline: 'El binario, la imagen, workflows ilimitados.',
      features: ['Runtime completo y Recovery Center', 'Trae tu propia clave del proveedor de IA', 'Soporte de la comunidad'],
      cta: 'Descargar el binario',
    },
    team: {
      name: 'Team',
      price: 'Hablemos',
      tagline: 'Para equipos que corren workflows de los que otros dependen.',
      features: ['Todo lo de Self-hosted', 'SSO y aprovisionamiento SCIM con WorkOS', 'Actualizaciones gestionadas y soporte prioritario'],
      cta: 'Iniciar una conversación',
    },
    enterprise: {
      name: 'Enterprise',
      price: 'A medida',
      tagline: 'SLAs de recuperación, soporte dedicado, compras.',
      features: ['Todo lo de Team', 'Retención del registro de auditoría', 'Ingeniero asignado, onboarding'],
      cta: 'Hablemos',
    },
  },
  faq: {
    kicker: 'Preguntas',
    title: 'Lo primero que preguntan los operadores.',
    items: [
      {
        q: '¿Necesito Kubernetes?',
        a: 'No. Un ejecutable sirve la API, la app web, los workers y los bucles de mantenimiento, y PostgreSQL 18 es la única dependencia. Cada release incluye la construcción de una imagen de contenedor.',
      },
      {
        q: '¿Dónde viven mis datos?',
        a: 'En tu PostgreSQL. Las credenciales se cifran con envelope encryption y nunca aparecen en listados, logs ni errores; las llamadas salientes pasan validación SSRF, DNS pinning y límites de bytes.',
      },
      {
        q: '¿Qué pasa cuando el proveedor de IA se cae o se acaba el presupuesto?',
        a: 'La ejecución sigue. Cada paso de IA tiene un sobre de respaldo determinista, y un bloqueo de presupuesto detiene la llamada pagada, no el workflow. Hoy el proveedor es Anthropic; tú traes la clave.',
      },
      {
        q: '¿Puede usar mis herramientas y agentes actuales?',
        a: 'Sí. Janusly es cliente MCP de tus herramientas y servidor MCP que expone tus workflows a los agentes que ya usas.',
      },
      {
        q: '¿Está en español?',
        a: 'El producto se entrega en inglés y español, y este sitio también.',
      },
    ],
  },
  finalCta: {
    title: 'Corre tu primer workflow en diez minutos.',
    body: 'Descarga la imagen, apúntala a PostgreSQL y abre el Recovery Center. Nada que registrar.',
  },
  footer: {
    rights: '© 2026 Janusly · janusly.app',
    docs: 'Docs',
    github: 'GitHub',
    security: 'Seguridad',
    contact: 'Contacto',
  },
};
