# Admin de la agenda de manicurista — sitio separado

Cualquier ruta de este subdominio va al panel de Apps Script.

| URL | Destino |
|-----|---------|
| <https://demo-manicurista-agenda-admin.netlify.app/> | panel de administración |

Desplegar:

```bash
netlify deploy --dir netlify-site-admin --prod --site ecf5b54c-a088-4a78-8934-e12545f05ecc
```

`authuser=0` evita el reescritura de URL del multi-login de Google y el
redirect es 302 para que el navegador no cachee el destino.
