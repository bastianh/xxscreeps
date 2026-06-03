# Kubernetes

## Image Build Und Push

`build-and-push.sh` baut ein OCI-Archiv mit `docker buildx`, pusht es per `skopeo` in die Zot
Registry und aktualisiert danach die Image-Tags in `deployment.yaml` und `pvc-shell.yaml`.

Beispiel:

```bash
./k8s/build-and-push.sh 8
```

Standardwerte:

```bash
IMAGE_REPO=registry.zeta.w4rl0ck.dev/xxscreeps
PLATFORM=linux/amd64
ARCHIVE_PATH=/tmp/xxscreeps.tar
```

Mit abweichenden Werten:

```bash
IMAGE_REPO=registry.zeta.w4rl0ck.dev/xxscreeps PLATFORM=linux/amd64 ARCHIVE_PATH=/tmp/xxscreeps.tar ./k8s/build-and-push.sh 8
```

## Deployment-Layout

Es gibt zwei Deployment-Varianten:

- `deployment-single.yaml`: ein Container mit `xxscreeps start`
- `deployment-multi.yaml`: `main`, `processor`, `runner`, `backend` als getrennte Container plus
  `runtime-bootstrap` als `initContainer`

Aktiv ist immer genau eine Variante. Gesteuert wird das direkt in `k8s/kustomization.yaml`, indem
du in `resources:` genau eine der beiden Deployment-Dateien aktivierst.

Das Runtime-Image fur das Haupt-Deployment wird zentral in `k8s/kustomization.yaml` uber
`images:` gepflegt. `kubectl apply -k k8s` zieht also die Image-Definition von dort. Der
temporare `pvc-shell`-Pod bleibt separat, weil er weiterhin direkt per `kubectl apply -f`
angewendet wird.

## Hilfsskripte

Zum Anhalten, Starten und Neustarten des Deployments liegen kleine Wrapper-Skripte in `k8s/`:

```bash
./k8s/stop.sh
./k8s/start.sh
./k8s/restart.sh
```

- `stop.sh` skaliert das Deployment auf `0`
- `start.sh` skaliert es wieder auf `1`
- `restart.sh` fuhrt ein Rolling Restart aus und ist der normale Weg, um geanderte Mods,
  `package.json`-Abhangigkeiten oder Config neu einzulesen

## PVC Shell

`pvc-shell.yaml` startet einen temporaren Pod mit demselben Runtime-Image wie das Deployment,
aber ohne Serverstart. Der Pod mountet den PVC `xxscreeps-data` nach `/data` und bindet
dieselbe ConfigMap und dieselben Secrets wie das Haupt-Deployment ein.

Pod starten:

```bash
kubectl apply -f k8s/pvc-shell.yaml
```

Shell im Pod offnen:

```bash
kubectl -n xxscreeps exec -it pvc-shell -- /bin/sh
```

Nutzliche Checks im Pod:

```bash
node --version
ls -la /data
cat /data/.screepsrc.yaml
```

`xxscreeps` nicht ohne Subcommand starten. Ein nackter Aufruf offnet die interaktive CLI und
ist fur reine Debugging-Arbeit meist nicht das Gewunschte.

Stattdessen gezielt verwenden:

```bash
./node_modules/.bin/xxscreeps cli
./node_modules/.bin/xxscreeps import --dont-overwrite
/usr/local/bin/docker-entrypoint.sh import --dont-overwrite
```

Pod aufraumen:

```bash
kubectl -n xxscreeps delete pod pvc-shell
```

## Alternativen Screeps-Dump importieren

Wenn du einen anderen Screeps-World-Dump im selben Format wie der Standard-Import einspielen
willst, kannst du ihn direkt mit `xxscreeps import` importieren. Das erste positionsbasierte
Argument ist der Pfad zur JSON-Dump-Datei.

Deployment anhalten:

```bash
kubectl -n xxscreeps scale deployment xxscreeps --replicas=0
```

Shell-Pod starten:

```bash
kubectl apply -f k8s/pvc-shell.yaml
kubectl -n xxscreeps exec -it pvc-shell -- /bin/sh
```

Dump in den Pod kopieren:

```bash
kubectl -n xxscreeps cp /lokaler/pfad/dein-dump.json pvc-shell:/data/import.json
```

Optional aktuelles Datenverzeichnis sichern:

```bash
cp -a /data/screeps /data/screeps.backup
```

Dump importieren:

```bash
/usr/local/bin/docker-entrypoint.sh import /data/import.json
```

Direkt uber das installierte Binary geht es ebenfalls:

```bash
./node_modules/.bin/xxscreeps import /data/import.json
```

Hinweis: Ohne `--dont-overwrite` wird die bestehende Datenbank vor dem Import geleert. Wenn nur
die Shard-Daten ersetzt werden sollen, kannst du stattdessen `--shard-only` verwenden:

```bash
./node_modules/.bin/xxscreeps import --shard-only /data/import.json
```

Danach aufraumen und das Deployment wieder starten:

```bash
kubectl -n xxscreeps delete pod pvc-shell
kubectl -n xxscreeps scale deployment xxscreeps --replicas=1
```

Wenn der PVC nur exklusiv gemountet werden darf, das Deployment vorher anhalten und danach
wieder starten:

```bash
kubectl -n xxscreeps scale deployment xxscreeps --replicas=0
kubectl apply -f k8s/pvc-shell.yaml
kubectl -n xxscreeps exec -it pvc-shell -- /bin/sh
kubectl -n xxscreeps delete pod pvc-shell
kubectl -n xxscreeps scale deployment xxscreeps --replicas=1
```
