# Himma — baseline observability (docs/37 §24–§26; docs/36 IN-10 minimum,
# OP-07): ECS stdout JSON → CloudWatch Logs (bounded retention), metric
# filters on the W6 structured operational-alert lines, infrastructure alarms
# (ALB 5xx / unhealthy targets, RDS CPU/storage/connections, ECS running
# tasks), one SNS topic as the alert seam's destination. The HUMAN
# destination (email/Slack/PagerDuty) is an owner/ops input — an optional
# email subscription variable; nothing is fabricated (docs/36 OP-08).

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" { type = string }
variable "environment" { type = string }
variable "log_retention_days" {
  type    = number
  default = 30
}
variable "alert_email" {
  type        = string
  description = "Optional operator email for the alert topic (confirmation required by SNS). Empty = topic only."
  default     = ""
}
variable "alb_arn_suffix" { type = string }
variable "target_group_arn_suffix" { type = string }
variable "db_instance_identifier" { type = string }
variable "ecs_cluster_name" { type = string }
variable "api_service_name" { type = string }
variable "worker_service_name" { type = string }
variable "api_desired_count" { type = number }
variable "worker_desired_count" { type = number }
variable "kms_key_id" {
  type    = string
  default = ""
}
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  tags = merge(var.tags, { "himma:environment" = var.environment, "himma:component" = "observability" })
}

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/himma/${var.environment}/backend"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.kms_key_id != "" ? var.kms_key_id : null
  tags              = local.tags
}

resource "aws_sns_topic" "alerts" {
  name              = "${var.name}-alerts"
  kms_master_key_id = var.kms_key_id != "" ? var.kms_key_id : null
  tags              = local.tags
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---- W6 structured alert lines → metrics (docs/37 §26) ---------------------
# The alert seam logs {"alert":"raised","code":"<code>",...}; each code
# becomes a metric so alarms can page on the classes that matter.
locals {
  alert_codes = {
    stuckPaymentState                = "critical"
    reconciliationDiscrepancy        = "critical"
    scheduledJobFailingConsecutively = "critical"
    scheduledJobMissed               = "critical"
  }
}

resource "aws_cloudwatch_log_metric_filter" "alerts" {
  for_each       = local.alert_codes
  name           = "${var.name}-alert-${each.key}"
  log_group_name = aws_cloudwatch_log_group.backend.name
  pattern        = "{ $.alert = \"raised\" && $.code = \"${each.key}\" }"
  metric_transformation {
    name          = "OperationalAlert_${each.key}"
    namespace     = "Himma/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "operational_alerts" {
  for_each            = local.alert_codes
  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = "W6 operational alert raised: ${each.key} (see the structured log line for machine facts)"
  namespace           = "Himma/${var.environment}"
  metric_name         = "OperationalAlert_${each.key}"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}

# Startup refusals / fatal lines (role tagged, never secrets).
resource "aws_cloudwatch_log_metric_filter" "startup_refused" {
  name           = "${var.name}-startup-refused"
  log_group_name = aws_cloudwatch_log_group.backend.name
  pattern        = "\"startup refused\""
  metric_transformation {
    name          = "StartupRefused"
    namespace     = "Himma/${var.environment}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "startup_refused" {
  alarm_name          = "${var.name}-startup-refused"
  alarm_description   = "A production process refused to start (config/identity/migration head) — check the log line"
  namespace           = "Himma/${var.environment}"
  metric_name         = "StartupRefused"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}

# ---- infrastructure alarms ---------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-alb-5xx"
  alarm_description   = "API 5xx responses (target) ≥ 10 in 5 minutes"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = var.alb_arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy" {
  alarm_name          = "${var.name}-api-unhealthy-targets"
  alarm_description   = "API readiness failing on ≥ 1 target for 2 minutes (docs/37 §26: readiness failing > 2 min)"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = var.alb_arn_suffix, TargetGroup = var.target_group_arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name}-rds-cpu"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = var.db_instance_identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${var.name}-rds-free-storage"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = var.db_instance_identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5368709120 # 5 GiB
  comparison_operator = "LessThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${var.name}-rds-connections"
  alarm_description   = "Connections approaching the bounded pool budget (api ×2 + worker ×2 + jobs ≈ ≤ 60)"
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = { DBInstanceIdentifier = var.db_instance_identifier }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 120
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "worker_running" {
  alarm_name          = "${var.name}-worker-running-tasks"
  alarm_description   = "Worker heartbeat absent: fewer running worker tasks than desired for 5 minutes (docs/37 §26)"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = var.worker_service_name }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.worker_desired_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "api_running" {
  alarm_name          = "${var.name}-api-running-tasks"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = var.ecs_cluster_name, ServiceName = var.api_service_name }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.api_desired_count
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
  tags                = local.tags
}

output "log_group_name" { value = aws_cloudwatch_log_group.backend.name }
output "alerts_topic_arn" { value = aws_sns_topic.alerts.arn }
