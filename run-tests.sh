#!/bin/sh
# Everything, in the order that fails fastest. Run this before every push.
set -e
for t in cn2 pool sync scope page endpoints audit; do
  printf "%-11s " "$t"
  node "test/$t.test.js" | tail -1
done
node --check server.js && echo "server.js  syntax ok"
