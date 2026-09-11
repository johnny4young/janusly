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
    requestAccess: 'Solicitar acceso',
    seeRecoveryCenter: 'Ver el Recovery Center',
    readDocs: 'Leer la documentación',
    talkToUs: 'Hablemos',
  },
  nav: {
    why: 'Por qué Janusly',
    product: 'Producto',
    access: 'Acceso',
    faq: 'Preguntas',
    docs: 'Docs',
  },
  hero: {
    pill: 'Self-hosted · un ejecutable · tu PostgreSQL',
    title: 'El operador de IA para tus workflows de negocio.',
    lede:
      'Janusly convierte la intención en un workflow revisable, comprueba los resultados de negocio declarados y lleva los fallos a una recuperación gobernada. Completar una ejecución no equivale a verificar su resultado. Un binario en Go, en tu infraestructura.',
    note: 'Imagen Docker o un solo binario. PostgreSQL 18. Sin plano de control que alquilar.',
    screenshotAlt: 'Cola de recuperación de Janusly con dos fallos abiertos y uno seleccionado',
    caption: 'La cola de recuperación: cada paso fallido, agrupado por causa, con la evidencia para una decisión gobernada.',
  },
  trust: {
    binary: 'Un ejecutable en Go',
    postgres: 'PostgreSQL como cola durable',
    mcp: 'Cliente y servidor MCP',
    otel: 'OpenTelemetry integrado',
    credentials: 'Credenciales aisladas por organización',
  },
  why: {
    kicker: 'Por qué Janusly',
    title: 'Diseña, ejecuta, verifica y recupera en un solo lugar.',
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
    lede: 'Tres superficies, un runtime, sin diagramas: cada pantalla es el producto sobre una organización de demostración.',
    screens: {
      recovery: {
        title: 'Recovery Center',
        caption: 'La cola de pasos fallidos, el grupo al que pertenecen, las campañas de reintento y las propuestas de auto-healing que esperan una decisión.',
        alt: 'Recovery Center de Janusly: la cola de fallos con el panel de automatización abierto',
      },
      studio: {
        title: 'AI Studio',
        caption: 'Un brief de intención compilado desde una frase, las capacidades a las que se enlaza y una propuesta que lees antes de que sea un borrador.',
        alt: 'AI Studio de Janusly: un brief compilado y una propuesta de workflow',
      },
      home: {
        title: 'Inicio',
        caption: 'La página de entrada del operador: postura del resultado, la caída más larga todavía contando y la siguiente acción, calculadas desde tus ejecuciones.',
        alt: 'Inicio de Janusly: el Recovery Center con anillo de salud y siguientes acciones',
      },
    },
  },
  access: {
    kicker: 'Acceso',
    title: 'Evalúa Janusly en tu infraestructura.',
    body: 'Revisa primero el producto y su evidencia. El uso requiere permiso previo por escrito; consulta al titular sobre la licencia y el despliegue.',
    cta: 'Consultar acceso en GitHub',
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
        a: 'El estado y la evidencia de los workflows viven en tu PostgreSQL. Las integraciones y proveedores de IA configurados reciben los datos necesarios para sus llamadas. Las credenciales se cifran en reposo y se excluyen de listados, logs y errores; se usan en llamadas autorizadas al proveedor.',
      },
      {
        q: '¿Qué pasa cuando el proveedor de IA se cae o se acaba el presupuesto?',
        a: 'Las llamadas de IA devuelven un sobre de respaldo determinista ante indisponibilidad o falta de presupuesto. Ese respaldo no prueba que se logró el objetivo: las comprobaciones configuradas pueden rechazarlo o poner en cuarentena los pasos siguientes.',
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
    title: 'Empieza con un workflow cuyo resultado puedas verificar.',
    body: 'Revisa el recorrido sin proveedores reales y sus límites de evidencia antes de autorizar acciones sobre un servicio real.',
  },
  footer: {
    rights: '© 2026 Janusly · janusly.app',
    docs: 'Docs',
    github: 'GitHub',
    security: 'Seguridad',
    contact: 'Contacto',
  },
};
