# phoenix.eilmer.si

A Cloudflare Worker that serves the Phoenix installer. `/install` returns `install.sh` from the latest GitHub release, so the installer always matches the archives it downloads. `/` redirects to the repository; every other path is 404.

Run it locally with `npx wrangler dev` from this folder, and deploy it with `npx wrangler deploy`. The config attaches the Worker to phoenix.eilmer.si as a custom domain.
