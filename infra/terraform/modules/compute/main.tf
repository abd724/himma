# Himma — ECS/Fargate compute (docs/37 §4; docs/38 §8/§10): ONE image, four
# task definitions selected by command, two long-running services (api behind
# the ALB, worker with no ingress) and two short-lived run-task definitions
# (maintenance under the maintenance credential, migrate/provision under the
# schema-owner credential). Per-invocation IAM: every task definition has its
# OWN execution role that may read ONLY its own secrets, and its OWN task
# role (the API's task role is the only one with evidence-bucket access).
# EventBridge Scheduler runs the approved engineering retention composite
# (`retention.all`) daily as a maintenance run-task; nothing policy-gated is
# scheduled.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" { type = string }
variable "environment" { type = string }
variable "region" { type = string }
variable "image" {
  type        = string
  description = "Immutable image reference (repository:git-sha). Deployments change ONLY this."
}
variable "app_subnet_ids" { type = list(string) }
variable "public_subnet_ids" { type = list(string) }
variable "tasks_in_public_subnets" {
  type        = bool
  description = "Staging cost mode: place tasks in public subnets with public IPs (no NAT). Production: false."
  default     = false
}
variable "api_security_group_id" { type = string }
variable "worker_security_group_id" { type = string }
variable "jobs_security_group_id" { type = string }
variable "api_target_group_arn" { type = string }
variable "api_desired_count" {
  type    = number
  default = 2
}
variable "worker_desired_count" {
  type    = number
  default = 2
}
variable "api_cpu" {
  type    = number
  default = 512
}
variable "api_memory" {
  type    = number
  default = 1024
}
variable "worker_cpu" {
  type    = number
  default = 256
}
variable "worker_memory" {
  type    = number
  default = 512
}
variable "jobs_cpu" {
  type    = number
  default = 512
}
variable "jobs_memory" {
  type    = number
  default = 1024
}
variable "log_group_name" { type = string }
variable "secret_arns" {
  type        = map(string)
  description = "Output of the secrets module (name → ARN)."
}
variable "rds_master_secret_arn" {
  type        = string
  description = "RDS-managed schema-owner secret — readable ONLY by the migrate/provisioning task."
}
variable "database_host" { type = string }
variable "database_name" { type = string }
variable "database_master_username" { type = string }
variable "evidence_access_policy_arn" {
  type    = string
  default = ""
}
variable "evidence_bucket_name" {
  type    = string
  default = ""
}
variable "public_config" {
  type        = map(string)
  description = "Non-secret runtime variables shared by api/worker (COGNITO_*, PORTAL_ALLOWED_ORIGINS, AUTH_COOKIE_DOMAIN, PAYMENT_CHECKOUT_*_URL, LOG_LEVEL, SCHEDULER_*, WORKER_*, …)."
  default     = {}
}
variable "payments_mode" {
  type        = string
  description = "disabled | test — there is NO live value in the application; Terraform refuses anything else."
  default     = "disabled"
  validation {
    condition     = contains(["disabled", "test"], var.payments_mode)
    error_message = "payments_mode must be disabled or test; live enablement is the owner-gated PA-06 slice, never configuration."
  }
}
variable "retention_schedule_expression" {
  type        = string
  description = "EventBridge Scheduler expression for retention.all (docs/37 §13: daily). UTC."
  default     = "cron(30 1 * * ? *)"
}
variable "enable_retention_schedule" {
  type    = bool
  default = true
}
variable "shutdown_drain_ms" {
  type    = number
  default = 15000
}
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  tags         = merge(var.tags, { "himma:environment" = var.environment, "himma:component" = "compute" })
  task_subnets = var.tasks_in_public_subnets ? var.public_subnet_ids : var.app_subnet_ids
  assign_ip    = var.tasks_in_public_subnets
  ca_file      = "/etc/himma/certs/rds-global-bundle.pem"

  common_env = merge(
    {
      NODE_ENV             = "production"
      DATABASE_SSL_MODE    = "verify-full"
      DATABASE_SSL_CA_FILE = local.ca_file
      SHUTDOWN_DRAIN_MS    = tostring(var.shutdown_drain_ms)
    },
    var.public_config,
  )

  # ECS `stopTimeout` must exceed the application drain budget so SIGTERM →
  # drain → exit 0 completes before SIGKILL (docs/37 §8).
  stop_timeout = min(120, ceil(var.shutdown_drain_ms / 1000) + 10)

  payment_secret_refs = var.payments_mode == "test" ? [
    { name = "STRIPE_SECRET_KEY", valueFrom = "${var.secret_arns["stripe/test"]}:STRIPE_SECRET_KEY::" },
    { name = "STRIPE_WEBHOOK_SECRET", valueFrom = "${var.secret_arns["stripe/test"]}:STRIPE_WEBHOOK_SECRET::" },
  ] : []

  evidence_secret_refs = var.evidence_bucket_name != "" ? [
    { name = "EVIDENCE_S3_ACCESS_KEY_ID", valueFrom = "${var.secret_arns["evidence/s3"]}:EVIDENCE_S3_ACCESS_KEY_ID::" },
    { name = "EVIDENCE_S3_SECRET_ACCESS_KEY", valueFrom = "${var.secret_arns["evidence/s3"]}:EVIDENCE_S3_SECRET_ACCESS_KEY::" },
  ] : []

  evidence_env = var.evidence_bucket_name != "" ? {
    EVIDENCE_S3_ENDPOINT   = "https://s3.${var.region}.amazonaws.com"
    EVIDENCE_S3_REGION     = var.region
    EVIDENCE_S3_BUCKET     = var.evidence_bucket_name
    EVIDENCE_S3_KEY_PREFIX = "evidence"
  } : {}

  db_url = { for role, login in { api = "himma_api", worker = "himma_worker", maintenance = "himma_maintenance_runner" } :
  role => "postgres://${login}@${var.database_host}:5432/${var.database_name}" }

  roles = {
    api = {
      command = ["scripts/start-api.ts"]
      cpu     = var.api_cpu
      memory  = var.api_memory
      env     = merge(local.common_env, local.evidence_env, { RUNTIME_ROLE = "api", HOST = "0.0.0.0", PORT = "8080", PAYMENTS_MODE = var.payments_mode, DATABASE_URL = local.db_url["api"] })
      secrets = concat([
        { name = "DATABASE_PASSWORD", valueFrom = "${var.secret_arns["db/api"]}:password::" },
        { name = "HIMMA_STAFF_INVITATION_PEPPER", valueFrom = "${var.secret_arns["app/peppers"]}:HIMMA_STAFF_INVITATION_PEPPER::" },
        { name = "HIMMA_MFA_RECOVERY_PEPPER", valueFrom = "${var.secret_arns["app/peppers"]}:HIMMA_MFA_RECOVERY_PEPPER::" },
      ], local.payment_secret_refs, local.evidence_secret_refs)
      secret_read   = compact([var.secret_arns["db/api"], var.secret_arns["app/peppers"], var.payments_mode == "test" ? var.secret_arns["stripe/test"] : "", var.evidence_bucket_name != "" ? var.secret_arns["evidence/s3"] : ""])
      port_mappings = [{ containerPort = 8080, protocol = "tcp" }]
    }
    worker = {
      command       = ["scripts/start-worker.ts"]
      cpu           = var.worker_cpu
      memory        = var.worker_memory
      env           = merge(local.common_env, { RUNTIME_ROLE = "worker", PAYMENTS_MODE = var.payments_mode, WORKER_STATUS_PORT = "8090", DATABASE_URL = local.db_url["worker"] })
      secrets       = concat([{ name = "DATABASE_PASSWORD", valueFrom = "${var.secret_arns["db/worker"]}:password::" }], local.payment_secret_refs)
      secret_read   = compact([var.secret_arns["db/worker"], var.payments_mode == "test" ? var.secret_arns["stripe/test"] : ""])
      port_mappings = []
    }
    maintenance = {
      command       = ["scripts/start-maintenance.ts", "retention.all"]
      cpu           = var.jobs_cpu
      memory        = var.jobs_memory
      env           = merge(local.common_env, { RUNTIME_ROLE = "maintenance", DATABASE_URL = local.db_url["maintenance"] })
      secrets       = [{ name = "DATABASE_PASSWORD", valueFrom = "${var.secret_arns["db/maintenance"]}:password::" }]
      secret_read   = [var.secret_arns["db/maintenance"]]
      port_mappings = []
    }
    # Schema-owner authority, bounded to this task definition: migrations
    # (`db:migrate` / `db:verify`) and role provisioning (`db:provision-roles`
    # — reads the three runtime passwords so nothing is duplicated).
    migrate = {
      command = ["scripts/db-migrate.ts"]
      cpu     = var.jobs_cpu
      memory  = var.jobs_memory
      env     = merge(local.common_env, { RUNTIME_ROLE = "migrate", DATABASE_URL = "postgres://${var.database_master_username}@${var.database_host}:5432/${var.database_name}" })
      secrets = [
        { name = "DATABASE_PASSWORD", valueFrom = "${var.rds_master_secret_arn}:password::" },
        { name = "HIMMA_API_DB_PASSWORD", valueFrom = "${var.secret_arns["db/api"]}:password::" },
        { name = "HIMMA_WORKER_DB_PASSWORD", valueFrom = "${var.secret_arns["db/worker"]}:password::" },
        { name = "HIMMA_MAINTENANCE_DB_PASSWORD", valueFrom = "${var.secret_arns["db/maintenance"]}:password::" },
      ]
      secret_read   = [var.rds_master_secret_arn, var.secret_arns["db/api"], var.secret_arns["db/worker"], var.secret_arns["db/maintenance"]]
      port_mappings = []
    }
  }
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# ---- IAM: one execution role + one task role per invocation ---------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  for_each           = local.roles
  name               = "${var.name}-exec-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

# Pull the image + write logs (managed policy), plus EXACTLY this role's secrets.
resource "aws_iam_role_policy_attachment" "execution_managed" {
  for_each   = local.roles
  role       = aws_iam_role.execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  for_each = local.roles
  statement {
    sid       = "ReadOwnSecretsOnly"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = each.value.secret_read
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  for_each = local.roles
  name     = "read-own-secrets"
  role     = aws_iam_role.execution[each.key].id
  policy   = data.aws_iam_policy_document.execution_secrets[each.key].json
}

resource "aws_iam_role" "task" {
  for_each           = local.roles
  name               = "${var.name}-task-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.tags
}

# Only the API task role touches the evidence bucket (docs/38 §2.7). Worker,
# maintenance and migrate task roles carry NO AWS API permissions at all.
resource "aws_iam_role_policy_attachment" "api_evidence" {
  count      = var.evidence_access_policy_arn != "" ? 1 : 0
  role       = aws_iam_role.task["api"].name
  policy_arn = var.evidence_access_policy_arn
}

# ---- task definitions -------------------------------------------------------

resource "aws_ecs_task_definition" "this" {
  for_each                 = local.roles
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  tags                     = merge(local.tags, { "himma:runtime-role" = each.key })

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name                   = "backend"
      image                  = var.image
      essential              = true
      command                = each.value.command
      environment            = [for k, v in each.value.env : { name = k, value = v }]
      secrets                = each.value.secrets
      portMappings           = each.value.port_mappings
      stopTimeout            = local.stop_timeout
      readonlyRootFilesystem = true
      user                   = "10001:10001"
      linuxParameters        = { initProcessEnabled = false }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = var.log_group_name
          awslogs-region        = var.region
          awslogs-stream-prefix = each.key
        }
      }
    }
  ])
}

# ---- services ---------------------------------------------------------------

resource "aws_ecs_service" "api" {
  name                              = "${var.name}-api"
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.this["api"].arn
  desired_count                     = var.api_desired_count
  launch_type                       = "FARGATE"
  platform_version                  = "LATEST"
  health_check_grace_period_seconds = 60
  enable_execute_command            = false
  propagate_tags                    = "SERVICE"
  tags                              = merge(local.tags, { "himma:runtime-role" = "api" })

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true # a failed rollout (readiness never green) rolls back to the previous task definition automatically
  }

  network_configuration {
    subnets          = local.task_subnets
    security_groups  = [var.api_security_group_id]
    assign_public_ip = local.assign_ip
  }

  load_balancer {
    target_group_arn = var.api_target_group_arn
    container_name   = "backend"
    container_port   = 8080
  }

  lifecycle {
    ignore_changes = [desired_count] # operators may scale without a plan diff
  }
}

resource "aws_ecs_service" "worker" {
  name                   = "${var.name}-worker"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.this["worker"].arn
  desired_count          = var.worker_desired_count
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = false
  propagate_tags         = "SERVICE"
  tags                   = merge(local.tags, { "himma:runtime-role" = "worker" })

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = local.task_subnets
    security_groups  = [var.worker_security_group_id]
    assign_public_ip = local.assign_ip
  }
  # Deliberately NO load_balancer block: the worker has no public listener.

  lifecycle {
    ignore_changes = [desired_count]
  }
}

# ---- scheduled maintenance (docs/37 §13/§19; W6-3 retention.all) ------------

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  count              = var.enable_retention_schedule ? 1 : 0
  name               = "${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "scheduler_run_task" {
  count = var.enable_retention_schedule ? 1 : 0
  statement {
    sid       = "RunMaintenanceTaskOnly"
    effect    = "Allow"
    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.this["maintenance"].arn_without_revision, aws_ecs_task_definition.this["maintenance"].arn]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    sid       = "PassMaintenanceRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution["maintenance"].arn, aws_iam_role.task["maintenance"].arn]
  }
}

resource "aws_iam_role_policy" "scheduler_run_task" {
  count  = var.enable_retention_schedule ? 1 : 0
  name   = "run-maintenance-task"
  role   = aws_iam_role.scheduler[0].id
  policy = data.aws_iam_policy_document.scheduler_run_task[0].json
}

resource "aws_scheduler_schedule" "retention_all" {
  count                        = var.enable_retention_schedule ? 1 : 0
  name                         = "${var.name}-retention-all"
  description                  = "W6-3 engineering-scoped retention composite (retention.all) — the only scheduled maintenance command"
  schedule_expression          = var.retention_schedule_expression
  schedule_expression_timezone = "UTC"
  flexible_time_window {
    mode                      = "FLEXIBLE"
    maximum_window_in_minutes = 15
  }
  target {
    arn      = aws_ecs_cluster.this.arn
    role_arn = aws_iam_role.scheduler[0].arn
    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.this["maintenance"].arn
      launch_type         = "FARGATE"
      task_count          = 1
      network_configuration {
        subnets          = local.task_subnets
        security_groups  = [var.jobs_security_group_id]
        assign_public_ip = local.assign_ip
      }
    }
    retry_policy {
      maximum_retry_attempts = 0 # advisory lock + idempotent batches: a missed day is caught up next day
    }
  }
}

output "cluster_arn" { value = aws_ecs_cluster.this.arn }
output "cluster_name" { value = aws_ecs_cluster.this.name }
output "api_service_name" { value = aws_ecs_service.api.name }
output "worker_service_name" { value = aws_ecs_service.worker.name }
output "task_definition_arns" { value = { for k, td in aws_ecs_task_definition.this : k => td.arn } }
output "execution_role_arns" { value = { for k, r in aws_iam_role.execution : k => r.arn } }
output "task_role_arns" { value = { for k, r in aws_iam_role.task : k => r.arn } }
output "jobs_network" {
  description = "Subnets/security group for run-task invocations (migrate/maintenance) by the pipeline."
  value       = { subnets = local.task_subnets, security_group = var.jobs_security_group_id, assign_public_ip = local.assign_ip }
}
