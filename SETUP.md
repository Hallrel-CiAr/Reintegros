# Puesta en marcha — Pasajes de Referencia SOSUNC

Esta carpeta tiene 4 archivos. Los 4 tienen que quedar juntos, en el mismo lugar, cuando la subas a un servidor:

- `index.html` — la página.
- `app.js` — toda la lógica.
- `firebase-config.js` — la conexión a tu base de datos (hoy tiene valores de prueba).
- `firestore.rules` — las reglas de seguridad (esto NO se sube al servidor de archivos; se pega en la consola de Firebase, paso 4).

## Probarla ya, sin configurar nada

Podés abrir `index.html` directamente en el navegador (doble clic) tal cual está. Va a arrancar en **modo demo**: los datos quedan guardados solo en ese navegador (localStorage), para que puedas probar el diseño y las funciones. Nada de eso es compartido ni definitivo. Cuando completes los pasos de abajo, deja de estar en modo demo automáticamente.

## Pasar a modo real (datos compartidos, login con Gmail)

### 1. Crear el proyecto Firebase (gratis)

1. Entrá a **console.firebase.google.com** con la cuenta de Gmail que va a administrar esto (`matiasldg@gmail.com`).
2. "Agregar proyecto" → nombre, por ejemplo `pasajes-sosunc` → seguí los pasos (no hace falta Google Analytics, podés desactivarlo).
3. Alcanza con el plan gratuito ("Spark"): esta cantidad de datos y de gente usándolo está muy por debajo del límite gratis.

### 2. Habilitar el login con Google

1. En el menú lateral: **Compilación → Authentication** → "Comenzar".
2. Pestaña "Sign-in method" → habilitá el proveedor **Google**.
3. Elegí un email de soporte del proyecto (te va a pedir uno; podés usar el mismo `matiasldg@gmail.com`).
4. Pestaña **Settings** (Configuración) → **Authorized domains** (Dominios autorizados) → "Add domain" → agregá el dominio exacto donde vaya a vivir la página (por ejemplo `hallrel-ciar.github.io` si la usás con GitHub Pages, o el dominio de NextCloud). Sin este paso, el login falla con el error `auth/unauthorized-domain`. No hace falta poner la ruta completa, solo el dominio.

### 3. Crear la base de datos (Firestore)

1. Menú lateral: **Compilación → Firestore Database** → "Crear base de datos".
2. Ubicación: cualquiera de Sudamérica (`southamerica-east1`, por ejemplo) para que sea rápida desde Argentina.
3. Modo: "Producción" (las reglas de seguridad del paso 4 son las que de verdad controlan el acceso).

### 4. Pegar las reglas de seguridad

1. Dentro de Firestore Database, pestaña **Reglas**.
2. Borrá lo que haya y pegá el contenido completo del archivo `firestore.rules` de esta carpeta.
3. "Publicar".

Estas reglas son las que hacen cumplir, de verdad (no solo en la pantalla), que:
- Cualquiera que inicie sesión con Gmail puede **ver** los valores.
- Solo vos (`matiasldg@gmail.com`) y las personas que agregues desde "Gestionar accesos" pueden **cargar o corregir** valores.
- El historial de cambios (auditoría) no lo puede borrar ni modificar nadie una vez escrito, ni siquiera vos, desde la app.

### 5. Copiar la configuración a `firebase-config.js`

1. En Firebase, ícono de **engranaje → Configuración del proyecto**.
2. Abajo, en "Tus apps", tocá el ícono `</>` (Web) para registrar una app web. Nombre: por ejemplo `pasajes-web`. No hace falta Firebase Hosting.
3. Te va a mostrar un bloque `firebaseConfig = { apiKey: "...", ... }`.
4. Copiá esos valores dentro de `firebase-config.js`, reemplazando los que dicen `YOUR_...`.
5. Guardá el archivo.

Estas claves no son secretas — Firebase las diseña para que puedan ser públicas y viajar dentro del HTML. La seguridad real la dan las reglas del paso 4.

### 6. Subir los archivos al servidor

Subí `index.html`, `app.js` y `firebase-config.js` (los tres juntos, en la misma carpeta) al lugar donde vayan a vivir — NextCloud, cualquier hosting de archivos estáticos, etc. No hace falta ningún servidor con Python/Node: son 3 archivos planos.

Compartí ese link como haces hoy con cualquier archivo.

### 7. Primer ingreso

1. Entrá vos primero con `matiasldg@gmail.com` y tocá "Iniciar sesión con Google".
2. Vas a ver la sección **"Gestionar accesos"** al final de la página (solo la ves vos). Ahí agregás, uno por uno, los Gmail de las personas que van a poder cargar y corregir valores (por ejemplo Julieta).
3. Cualquier otra persona con el link puede entrar con su Gmail y **ver** los datos, aunque no la hayas agregado como editora.

## Qué cambia respecto de la versión anterior (la de Claude Artifacts)

- **Login real con Gmail**, en vez de "cualquiera con el link edita". Cada carga y cada corrección queda con el nombre de quien la hizo.
- **Solo vos podés decidir quién edita** — antes esto no se podía garantizar de verdad; ahora lo hacen cumplir las reglas de Firestore, no solo el diseño de la página.
- **Historial de cambios (auditoría)**: quién cargó o corrigió cada valor y cuándo, con lo que cambió. No se puede borrar ni alterar una vez escrito.
- **Importar CSV**: para restaurar un respaldo (el mismo formato que exporta "Historial y exportación"), por ejemplo si hace falta un cambio grande de estructura como el que ya pasó una vez con las categorías.
- **Ya no se borran solos los registros viejos** a los 6 meses. Antes se hacía porque toda la base de datos vivía dentro del propio archivo HTML y había que cuidar el tamaño; ahora vive en Firestore, así que se conserva todo salvo que decidan borrar algo a propósito.

## Búsqueda diaria automática

Todos los días (y de nuevo cada 2 horas, para que "Forzar actualización automática" tenga efecto el mismo día) se busca en **Plataforma 10** (terrestre, se guarda el promedio de los servicios disponibles) y **Google Flights** (aéreo, se guarda la tarifa más económica), y se completa solo lo que esté vacío — nunca pisa un valor ya cargado.

Corre como una **GitHub Action** (pestaña "Actions" del repositorio), no dentro de Claude, porque el entorno de Claude no tiene salida a esos sitios. El código está en `scripts/actualizar_automatico.js`.

### 8. Agregar la cuenta robot como editora

1. Entrá a la página con `matiasldg@gmail.com` → sección **"Accesos"** (en el menú "Accesos", solo la ves vos)
2. Agregá el email de la cuenta que creaste en Firebase Authentication (Email/contraseña) — por ejemplo `automatizacion@pasajes-sosunc.app`

### 9. Cargar los secretos en GitHub Actions

1. En el repositorio: **Settings → Secrets and variables → Actions → New repository secret**
2. Cargá estos 4, uno por uno (nombre exacto a la izquierda, valor a la derecha):
   - `FIREBASE_API_KEY` → el mismo valor de `apiKey` que está en `firebase-config.js`
   - `FIREBASE_PROJECT_ID` → el mismo valor de `projectId` que está en `firebase-config.js`
   - `ROBOT_EMAIL` → el email de la cuenta robot que creaste (paso 8)
   - `ROBOT_PASSWORD` → la contraseña de esa cuenta

Estos 4 secretos no se muestran ni se guardan en el código — solo GitHub Actions los usa al correr la tarea.

### 10. Probarlo

En la pestaña **Actions** del repositorio → "Actualización automática de pasajes" → **"Run workflow"** (no hace falta esperar al horario programado). Mirá el log de la corrida: te muestra ruta por ruta si encontró un valor, lo guardó, o no pudo confirmarlo.

Como esto no se pudo probar contra los sitios reales antes de publicarlo (ver nota en `scripts/actualizar_automatico.js`), esta primera corrida real es la que confirma si funciona. Si algo falla, copiá el log y compartilo para ajustarlo.

## Avisos de "faltan datos de hoy"

Son dentro de la página (el título de la pestaña cambia, y hay un botón para activar notificaciones del navegador) mientras la tengas abierta. No hay avisos por correo, porque eso requiere un servidor propio corriendo todo el tiempo.
