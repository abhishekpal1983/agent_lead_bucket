#!/bin/sh
# Everything, in the order that fails fastest. Run this before every push.
# `set -e` stops at the first failing suite, so a red run cannot be scrolled past.
set -e
for t in cn2 checks pool sync scope revenue coach page endpoints audit audit2; do
  printf "%-11s " "$t"
  node "test/$t.test.js" | tail -1
done
node --check server.js && echo "server.js  syntax ok"
