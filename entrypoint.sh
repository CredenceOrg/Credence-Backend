#!/bin/sh

# Set Node.js max old space size if environment variable is set
if [ -n "$NODE_MAX_OLD_SPACE_SIZE_MB" ]; then
  NODE_OPTIONS="--max-old-space-size=${NODE_MAX_OLD_SPACE_SIZE_MB} ${NODE_OPTIONS}"
  export NODE_OPTIONS
  echo "Setting Node.js max old space size to ${NODE_MAX_OLD_SPACE_SIZE_MB} MB"
fi

# Execute the command
exec "$@"
