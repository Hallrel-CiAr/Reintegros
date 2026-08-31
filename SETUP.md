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

## Lo que sigue igual que antes (decisiones que ya tomamos)

- **La búsqueda diaria de tarifas** (Kayak / Plataforma 10) la sigo disparando yo cuando me la pidan por este chat — no corre sola en ningún servidor.
- **Los avisos de "faltan datos de hoy"** son dentro de la página (el título de la pestaña cambia, y hay un botón para activar notificaciones del navegador) mientras la tengas abierta. No hay avisos por correo ni notificaciones push reales, porque eso requiere un servidor propio corriendo todo el tiempo, y elegiste no sumar esa complejidad por ahora.
