#!/bin/sh
set -e

CONFIG_PATH=/data/options.json

export PORT=3000
export THREECX_WEBHOOK_URL=$(grep -o '"threecx_webhook_url":[^,}]*' $CONFIG_PATH | cut -d'"' -f4)
export AA_SMS_URL=$(grep -o '"aa_sms_url":[^,}]*' $CONFIG_PATH | cut -d'"' -f4)
export AA_USERNAME=$(grep -o '"aa_username":[^,}]*' $CONFIG_PATH | cut -d'"' -f4)
export AA_PASSWORD=$(grep -o '"aa_password":[^,}]*' $CONFIG_PATH | cut -d'"' -f4)
export SHARED_SECRET=$(grep -o '"shared_secret":[^,}]*' $CONFIG_PATH | cut -d'"' -f4)
export INBOUND_PATH=$(grep -o '"inbound_path":[^,}]*' $CONFIG_PATH | cut -d'"' -f4)
export OUTBOUND_PATH=$(grep -o '"outbound_path":[^,}]*' $CONFIG_PATH | cut -d'"' -f4)

echo "Starting AA-3CX SMS bridge on port ${PORT}..."
exec node /app/server.js
