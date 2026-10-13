#!/bin/bash
set -e

# Start redis
sed -i "s/bind 127.0.0.1 ::1/bind 0.0.0.0/" /etc/redis/redis.conf || true
sed -i "s/protected-mode yes/protected-mode no/" /etc/redis/redis.conf || true
service redis-server restart

# Configure postgres
service postgresql start
sed -i "s/#listen_addresses = 'localhost'/listen_addresses = '*'/" /etc/postgresql/16/main/postgresql.conf || true
echo 'host all all 0.0.0.0/0 md5' >> /etc/postgresql/16/main/pg_hba.conf || true
echo 'host all all ::0/0 md5' >> /etc/postgresql/16/main/pg_hba.conf || true
service postgresql restart

# Setup postgres user and database
su - postgres -c "psql -c \"ALTER USER postgres WITH PASSWORD 'postgres';\""
su - postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname = 'reachinbox_db'\" | grep -q 1 || psql -c \"CREATE DATABASE reachinbox_db;\""

echo "SERVICES_READY"
