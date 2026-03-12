#!/bin/sh
mkdir -p /data
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
