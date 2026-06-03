#!/bin/sh
set -eu

kubectl -n xxscreeps scale deployment xxscreeps --replicas=1
