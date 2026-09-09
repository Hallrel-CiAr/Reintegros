# Seguimiento semanal — evaluación de datos automáticos (SOSUNC)

Registro diario de la corrida automática de pasajes de referencia (aéreo:
Aerolíneas Argentinas; terrestre: Central de Pasajes), para armar la
evaluación final el sábado 12/9/2026. Se genera solo — no requiere acción
manual salvo que se avise lo contrario.

Rutas seguidas: aéreo NQN-CABA / BRC-CABA / VDM-CABA; terrestre NQN-CABA /
BRC-CABA / VDM-CABA / ROC-CABA (7 en total).

---

## 2026-09-07 (lunes)

**⚠️ Anomalía: el cron programado (14:00 ART + reintentos hasta 15:30 ART) no se disparó en absoluto hoy.**

Revisado a las 19:06 UTC (16:06 ART) — más de 2 horas después de la última
ventana de reintento (18:30 UTC / 15:30 ART) — y no hay ningún workflow run
con `event: schedule` para el 7/9. La última corrida registrada es manual
(`workflow_dispatch`, run #45, disparada anoche 00:29 UTC del 7/9, en
realidad sobre datos del 6/9 tarde).

A diferencia de la demora de ~3hs que vimos el 6/9 (que sí terminó
disparándose sola, solo que tarde), hoy directamente no hay rastro de que
el cron haya corrido — ni siquiera con atraso. No se puede evaluar
completitud de rutas de hoy porque no hay corrida automática que revisar.

No se disparó ninguna corrida manual de reemplazo (esta rutina no dispara
workflows, solo lee resultados — ver instrucciones).

**Acción:** se avisa al usuario.

**Corrección (agregada el 8/9):** el cron sí terminó disparándose solo ese
día, pero recién entre las 20:24 y las 21:42 UTC (17:24-18:42 ART) — 4
corridas seguidas seguramente encoladas, cada una tardando pocos segundos
porque las anteriores ya habían completado las rutas. Además, los 7 valores
de la ruta ya estaban completos desde la madrugada por la corrida manual
(`workflow_dispatch` run #45, 00:29 UTC del 7/9) que hicimos con el usuario
la noche anterior — así que la completitud de datos del 7/9 fue en
realidad 7/7, aunque el cron programado haya llegado muy tarde. El aviso de
"no se puede evaluar completitud" de más arriba fue prematuro: sí había
datos, solo que cargados fuera de la ventana programada.

**Nota técnica para el informe final:** ese run manual (00:29 UTC = 21:29
ART del 6/9) procesó la fecha "2026-09-07" porque el script calcula "hoy"
en UTC, no en hora Argentina — a las 21:29 ART ya eran las 00:29 del día
siguiente en UTC. Fuera de la ventana normal (14:00-15:30 ART, que cae
íntegro en el mismo día en ambos husos), esto no afecta nada, pero conviene
tenerlo presente si alguna vez se dispara manual muy tarde a la noche.

---

## 2026-09-08 (martes)

**⚠️ Mismo patrón de demora del cron, 2do día seguido — se aplicó una corrección.**

A las 19:06 UTC (16:06 ART) tampoco hay ningún run con `event: schedule`
para hoy — mismo punto en el que ayer parecía "no disparado" pero terminó
apareciendo varias horas más tarde. Como esto ya es el 2do día consecutivo
con el mismo síntoma (las 4 ventanas en punto/media hora atrasándose
varias horas), no parece casualidad: coincide con lo que GitHub documenta
sobre que el tope de la hora y la media hora son los momentos de mayor
carga de todo Actions.

**Corrección aplicada:** se cambiaron los 4 horarios del cron de
`17:00/17:30/18:00/18:30 UTC` a `17:07/17:37/18:07/18:37 UTC` (commit del
8/9) para correr un poco corridos de esos picos, mismo criterio que ya usan
las herramientas de scheduling en general. Se va a poder confirmar si
ayuda recién con los próximos días — queda anotado para el informe del
sábado si la demora persiste incluso corriendo en otro minuto.

**Acción:** se avisa al usuario (cambio de código, no solo observación).

---

## 2026-09-09 (miércoles)

**🔴 Anomalía grave: CERO corridas de ningún tipo desde el 7/9 21:42 UTC — no es demora, es silencio total de 2 días.**

Revisado a las 19:06 UTC (16:06 ART). `total_count` de runs del workflow
sigue en 49 — el mismo número que al cerrar el 7/9. Es decir: en TODO el
8/9 y lo que va del 9/9 no corrió ni una sola vez, ni programada ni
manual — a diferencia de días anteriores donde al menos terminaba
disparándose tarde a la noche.

Se descartó que sea el workflow deshabilitado: `get_workflow` devuelve
`state: "active"`. Se confirmó que el archivo en `origin/main` tiene bien
el cron nuevo (commit `8d0c160`, minutos :07/:37). O sea: el cambio de
minuto de ayer no tuvo ni siquiera la oportunidad de probarse, porque el
scheduler de GitHub dejó de disparar el workflow por completo, con
cualquier configuración de cron.

Esto ya no se explica por "pico de carga a horario redondo" (la teoría de
ayer) — es un corte total. Sospecha sin confirmar: el repo se movió de
nombre (`reintegros` → `Reintegros`, el aviso "This repository moved"
aparece en cada push) y es un problema conocido de GitHub que un rename de
repositorio puede desincronizar el daemon de schedules. No se puede
confirmar ni arreglar esto desde acá (no hay forma de deshabilitar/rehabilitar
el workflow vía la API disponible, y no se puede acceder a la config del
repo en GitHub).

**Impacto real:** el 8/9 y el 9/9 (hoy) probablemente no tienen ninguna
búsqueda automática — hay que confirmar con el usuario si hizo carga
manual esos días, o si quedaron pendientes de verdad.

**Acción:** se avisa al usuario con urgencia — esto requiere que dispare
manual hoy y revise si conviene deshabilitar/rehabilitar el workflow desde
la interfaz de GitHub para intentar destrabar el scheduler.
