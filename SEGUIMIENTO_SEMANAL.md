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
