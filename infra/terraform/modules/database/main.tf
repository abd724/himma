# Himma — managed PostgreSQL (docs/38 §2.6/§8/§10; docs/23 §10.11 financial
# class): RDS for PostgreSQL 16, private subnets only, encrypted at rest,
# TLS REQUIRED (rds.force_ssl), automated backups with PITR, deletion
# protection, final snapshot on destroy. The master (schema-owner) password
# is generated and rotated by RDS itself in Secrets Manager
# (`manage_master_user_password`) — it never appears in Terraform state or
# source. Extensions Himma uses (btree_gist, pg_trgm) are standard RDS
# PostgreSQL extensions created by the migrations themselves.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" { type = string }
variable "environment" { type = string }
variable "database_subnet_ids" { type = list(string) }
variable "security_group_id" { type = string }
variable "instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "engine_version" {
  type        = string
  description = "PostgreSQL major (RDS picks the latest minor) — Himma is certified on PostgreSQL 16+ semantics."
  default     = "16"
}
variable "allocated_storage_gb" {
  type    = number
  default = 50
}
variable "max_allocated_storage_gb" {
  type    = number
  default = 200
}
variable "multi_az" {
  type    = bool
  default = true
}
variable "backup_retention_days" {
  type    = number
  default = 35
  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "Backups must be retained 7–35 days (PITR window)."
  }
}
variable "deletion_protection" {
  type    = bool
  default = true
}
variable "skip_final_snapshot" {
  type    = bool
  default = false
}
variable "performance_insights" {
  type    = bool
  default = true
}
variable "master_username" {
  type    = string
  default = "himma_owner"
}
variable "kms_key_id" {
  type        = string
  description = "Optional CMK for storage and the managed master secret; empty = AWS-managed key."
  default     = ""
}
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  tags = merge(var.tags, { "himma:environment" = var.environment, "himma:component" = "database" })
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-db"
  subnet_ids = var.database_subnet_ids
  tags       = local.tags
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-postgres16"
  family = "postgres16"
  tags   = local.tags

  # TLS is mandatory on the server side too (the application already refuses
  # plain TCP for any non-loopback host).
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  # Slow-query visibility (bounded logging; never row contents).
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
}

resource "aws_db_instance" "this" {
  identifier     = "${var.name}-postgres"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  db_name  = "himma"
  username = var.master_username
  # RDS generates/rotates the master password in Secrets Manager — no
  # plaintext in Terraform state or source (docs/38 §10).
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_id != "" ? var.kms_key_id : null

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_id != "" ? var.kms_key_id : null

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.security_group_id]
  publicly_accessible    = false
  multi_az               = var.multi_az
  parameter_group_name   = aws_db_parameter_group.this.name
  port                   = 5432

  backup_retention_period   = var.backup_retention_days
  backup_window             = "00:30-01:30" # UTC — 04:30 Dubai, off-peak
  maintenance_window        = "Mon:02:00-Mon:03:00"
  copy_tags_to_snapshot     = true
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : "${var.name}-postgres-final"
  delete_automated_backups  = false

  auto_minor_version_upgrade            = true
  performance_insights_enabled          = var.performance_insights
  performance_insights_retention_period = var.performance_insights ? 7 : null
  monitoring_interval                   = 0
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]

  apply_immediately = false
  tags              = local.tags

  lifecycle {
    ignore_changes = [engine_version] # minor upgrades applied by RDS
  }
}

output "endpoint" { value = aws_db_instance.this.address }
output "port" { value = aws_db_instance.this.port }
output "database_name" { value = aws_db_instance.this.db_name }
output "master_username" { value = aws_db_instance.this.username }
output "master_user_secret_arn" {
  description = "RDS-managed master secret (schema/migration authority). Read only by the migration + provisioning tasks."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}
output "instance_arn" { value = aws_db_instance.this.arn }
output "instance_identifier" { value = aws_db_instance.this.identifier }
