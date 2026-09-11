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

---

## 2026-09-10 (jueves)

**🔴 El cron sigue sin disparar solo — 3ra vez en 4 días, ahora justo el día del cambio grande de sistema.**

Hoy hubo un cambio grande de sistema (rutas configurables en vez de fijas,
+ 3 modos aéreo/terrestre/vehículo) que de paso cambió el cron de
`17:07/17:37/18:07/18:37 UTC` a `8:03/8:33/9:03/9:33/10:03 UTC` (5hs ART +
4 reintentos), commit `dc6b412` mergeado a `main` a las 11:19 UTC (8:19
ART). Revisando a las 19:05 UTC (16:05 ART), ninguna de las 5 ventanas de
hoy — ni las 2 anteriores al cambio (8:03/8:33, que corrían con el cron
viejo igual) ni las 3 posteriores al cambio (9:03/9:33/10:03, ya con el
cron nuevo) — generó un run con `event: schedule`. `get_workflow` sigue
devolviendo `state: "active"`. Es el mismo síntoma del 9/9 (silencio
total), no una demora.

**Importante:** hoy la completitud de datos NO depende de esto — se
dispararon 2 corridas manuales (`workflow_dispatch`, runs #54 y #55) para
probar la migración de rutas y corregir un bug de destino (`CABA` no lo
reconocían los buscadores; se corrigió a `Buenos Aires`/`Retiro` según
modo, commit `1204a14`). Con esa corrección, 4 de las 7 rutas migradas ya
cargaron valor real hoy:

| Ruta | Modo | Valor |
|---|---|---|
| NQN-CABA | Aéreo | $414.026 (turista) |
| NQN-CABA | Terrestre | $206.000 (cama, 1 servicio) |
| ROC-CABA | Terrestre | $189.000 (cama, 1 servicio) |
| VDM-CABA | Terrestre | $96.500 (cama, promedio 2 servicios) |

Quedaron pendientes (intento 2 de 5, no agotado): BRC-CABA aéreo (no
encontró sugerencias de autocompletado para "Bariloche" como origen — a
seguir si persiste), BRC-CABA terrestre y VDM-CABA aéreo (ambos con
mensaje real de "no hay servicio/vuelo hoy" del propio sitio, no parece
error de scraping).

Pero si el cron sigue sin disparar solo, esos 3 intentos que le quedaban
a cada ruta para hoy (hasta agotar sus 5 y recién ahí habilitar carga
manual) no van a correr — dependen 100% de que alguien dispare manual, lo
mismo que viene pasando desde el 8/9. Con el sistema nuevo esto pesa más
que antes: antes una ruta que fallaba tenía 4 reintentos automáticos
"gratis"; si el scheduler sigue caído, en la práctica hoy son 0.

**Acción:** se avisa al usuario — 3er día con el mismo patrón de scheduler
caído, ahora coincidiendo con el estreno del cron nuevo, y con impacto
directo en el mecanismo de reintentos/agotamiento del sistema recién
rediseñado.

**Corrección aplicada por el usuario (misma tarde):** deshabilitó y volvió
a habilitar el workflow desde la pestaña Actions de GitHub. `get_workflow`
confirmó el toggle (`updated_at` cambió a las 16:53 ART). Quedó pendiente
confirmar si esto destraba el scheduler recién con las ventanas de mañana
(las de hoy ya habían pasado todas).

---

## 2026-09-11 (viernes)

**🟡 El cron volvió a disparar solo (el disable/enable sirvió), pero con ~4-4.5hs de atraso en las 5 ventanas — y una ruta lleva 2 días seguidos sin poder cargar valor.**

Buena noticia primero: las 5 ventanas de hoy SÍ generaron runs con
`event: schedule` (algo que no pasaba desde el 7/9) — el disable/enable
del usuario ayer a la tarde destrabó el scheduler. Pero ninguna corrió a
su horario: las 5 ventanas (8:03/8:33/9:03/9:33/10:03 UTC) terminaron
disparándose entre las 12:46 y las 14:13 UTC — un atraso parejo de
~4h10m a ~4h43m en las 5, no random. Es un patrón distinto a los picos de
:00/:30 que motivaron el ajuste del 8/9 (esto es un atraso masivo y
constante, no una demora de minutos en el momento pico) — no tengo una
explicación confirmada, pero no descarto que sea un efecto colateral del
propio disable/enable (GitHub reprocesando/poniendo en cola el schedule
recién habilitado). A seguir mañana para ver si se corrige solo con el
tiempo.

**Completitud de hoy (2026-09-11), 8 rutas configuradas (una nueva desde
la pantalla "Rutas", con `createdDate` de hoy — todavía no le toca
buscar, entra en juego recién mañana):**

| Ruta | Modo | Valor | Nota |
|---|---|---|---|
| BRC-CABA | Aéreo | $198.788 (turista) | ✅ se resolvió — ayer no encontraba "Bariloche" en el autocompletado |
| NQN-CABA | Aéreo | $414.026 (turista) | igual a ayer |
| NQN-CABA | Terrestre | $206.000 (cama, 1 servicio) | igual a ayer |
| ROC-CABA | Terrestre | $198.450 (cama, promedio 2 servicios) | ayer $189.000 (+5%, no parece anómalo) |
| VDM-CABA | Aéreo | $622.645 (turista) | ✅ primera vez que resuelve — ayer decía "Sin vuelos" para ese día |
| VDM-CABA | Terrestre | $96.500 (cama, promedio 2 servicios) | igual a ayer |

**⚠️ BRC-CABA terrestre (Bariloche → Retiro) agotó hoy sus 5 intentos sin
encontrar valor — 2do día seguido sin poder cargar (ayer quedó pendiente,
hoy quedó agotado y ya habilita carga manual).** Mismo mensaje los 5
intentos: "La página indica que no hay servicios para la fecha pedida."
Sospecha (no confirmada): coincide con algo que ya se había visto antes
del rediseño — esta ruta parece tener muy pocas salidas diarias, y con el
cron corriendo ~4-4.5hs tarde (o sea, buscando cerca del mediodía ART en
vez de la madrugada), es posible que la búsqueda esté cayendo después de
que ya salió el único micro del día. Si el atraso del cron se corrige
solo, valdría la pena ver si esta ruta empieza a resolver sin más cambios
de código.

**Acción:** se avisa al usuario — la ruta agotada necesita carga manual
para hoy, y el atraso de ~4hs (aunque ya no es silencio total) sigue sin
explicación confirmada.
