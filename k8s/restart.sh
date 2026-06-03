#!/bin/sh
set -eu

kubectl -n xxscreeps rollout restart deployment xxscreeps
