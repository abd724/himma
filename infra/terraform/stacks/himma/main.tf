# Himma — the ONE root stack, applied once per WORKLOAD ACCOUNT with an
# environment var-file and its own remote state (docs/38 §8/§9):
#
#   terraform -chdir=infra/terraform/stacks/himma init -backend-config=../../envs/staging/backend.hcl
#   infra/scripts/tf-preflight.sh staging            # account/region/environment guard (refuses mismatch)
#   terraform -chdir=infra/terraform/stacks/himma plan -var-file=../../envs/staging/terraform.tfvars
#
# The provider is pinned to ONE region and ONE allowed account id: a plan
# against the wrong account is refused by the provider itself, before the
# preflight script even runs. Production apply is additionally refused by
# the preflight guard until W6-4B/owner review (docs/36 IN-12 first).
#
# No secret value, account root credential, or access key exists here.

terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
  backend "s3" {} # configured per environment via -backend-config (encrypted, versioned, S3-native locking)
}

# ---- inputs ------------------------------------------------------------------

variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}
variable "expected_account_id" {
  type        = string
  description = "The WORKLOAD account this stack may touch (never the Organizations management account). Non-secret configuration supplied per environment."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.expected_account_id))
    error_message = "expected_account_id must be a 12-digit AWS account id."
  }
}
variable "region" {
  type    = string
  default = "me-central-1"
  validation {
    condition     = var.region == "me-central-1"
    error_message = "The owner ruling (docs/36 IN-01) pins Himma to me-central-1."
  }
}
variable "azs" {
  type    = list(string)
  default = ["me-central-1a", "me-central-1b"]
}
variable "root_domain" {
  type        = string
  description = "Company-controlled registrable domain (e.g. himma.app). Ownership/delegation is an owner action; nothing is assumed."
}
variable "create_hosted_zone" {
  type    = bool
  default = false
}
variable "hosted_zone_id" {
  type    = string
  default = ""
}
variable "hostname_prefix" {
  type        = string
  description = "'' for production (api.<root>), 'staging.' for staging (api.staging.<root>)."
  default     = ""
}
variable "github_repository" { type = string }
variable "image_tag" {
  type        = string
  description = "Immutable backend image tag (git SHA) to run. Changed ONLY by the deployment pipeline (or an explicit operator rollback to a previous SHA)."
}
variable "image_repository_url" {
  type        = string
  description = "Override the image repository (production pulls the SAME immutable image from the staging account's ECR via cross-account read). Empty = this account's own repository."
  default     = ""
}
variable "payments_mode" {
  type    = string
  default = "disabled"
  validation {
    condition     = contains(["disabled", "test"], var.payments_mode)
    error_message = "payments_mode must be disabled or test — live does not exist."
  }
}
variable "api_desired_count" { type = number }
variable "worker_desired_count" { type = number }
variable "tasks_in_public_subnets" { type = bool }
variable "nat_gateway_count" { type = number }
variable "enable_interface_endpoints" { type = bool }
variable "db_instance_class" { type = string }
variable "db_multi_az" { type = bool }
variable "db_backup_retention_days" { type = number }
variable "db_deletion_protection" { type = bool }
variable "db_skip_final_snapshot" { type = bool }
variable "db_allocated_storage_gb" {
  type    = number
  default = 50
}
variable "cognito_deletion_protection" { type = bool }
variable "log_retention_days" { type = number }
variable "alert_email" {
  type    = string
  default = ""
}
variable "public_config" {
  type        = map(string)
  description = "Non-secret runtime variables (COGNITO_* are derived from the pool below; add PORTAL_ALLOWED_ORIGINS overrides, LOG_LEVEL, SCHEDULER_*, WORKER_* here)."
  default     = {}
}
variable "enable_evidence_bucket" {
  type    = bool
  default = true
}
variable "enable_retention_schedule" {
  type    = bool
  default = true
}
variable "create_build_role" {
  type    = bool
  default = true
}

# ---- providers ---------------------------------------------------------------

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.expected_account_id]
  default_tags {
    tags = {
      "himma:project"     = "himma"
      "himma:environment" = var.environment
      "himma:managed-by"  = "terraform"
    }
  }
}

provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1" # CloudFront certificates only
  allowed_account_ids = [var.expected_account_id]
  default_tags {
    tags = {
      "himma:project"     = "himma"
      "himma:environment" = var.environment
      "himma:managed-by"  = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name          = "himma-${var.environment}"
  api_host      = "api.${var.hostname_prefix}${var.root_domain}"
  portal_host   = "portal.${var.hostname_prefix}${var.root_domain}"
  admin_host    = "admin.${var.hostname_prefix}${var.root_domain}"
  web_host      = var.hostname_prefix == "" ? var.root_domain : "${trimsuffix(var.hostname_prefix, ".")}.${var.root_domain}"
  image         = "${var.image_repository_url != "" ? var.image_repository_url : module.registry.repository_url}:${var.image_tag}"
  cookie_domain = ".${var.hostname_prefix}${var.root_domain}"

  derived_public_config = {
    LOG_LEVEL                    = "info"
    COGNITO_ISSUER               = module.cognito.issuer
    COGNITO_CLIENT_IDS           = join(",", [module.cognito.client_ids["mobile"], module.cognito.client_ids["portal"], module.cognito.client_ids["admin"]])
    COGNITO_REFRESH_CLIENT_ID    = module.cognito.client_ids["portal"]
    PORTAL_ALLOWED_ORIGINS       = "https://${local.portal_host},https://${local.admin_host}"
    AUTH_COOKIE_DOMAIN           = trimprefix(local.cookie_domain, ".")
    AUTH_COOKIE_SECURE           = "true"
    PAYMENT_CHECKOUT_SUCCESS_URL = "https://${local.web_host}/checkout/return"
    PAYMENT_CHECKOUT_CANCEL_URL  = "https://${local.web_host}/checkout/cancel"
  }
}

# ---- modules -----------------------------------------------------------------

module "network" {
  source                     = "../../modules/network"
  name                       = local.name
  environment                = var.environment
  azs                        = var.azs
  nat_gateway_count          = var.nat_gateway_count
  enable_interface_endpoints = var.enable_interface_endpoints
}

module "registry" {
  source      = "../../modules/registry"
  name        = local.name
  environment = var.environment
}

module "secrets" {
  source      = "../../modules/secrets"
  name        = local.name
  environment = var.environment
}

module "database" {
  source                = "../../modules/database"
  name                  = local.name
  environment           = var.environment
  database_subnet_ids   = module.network.database_subnet_ids
  security_group_id     = module.network.database_security_group_id
  instance_class        = var.db_instance_class
  multi_az              = var.db_multi_az
  backup_retention_days = var.db_backup_retention_days
  deletion_protection   = var.db_deletion_protection
  skip_final_snapshot   = var.db_skip_final_snapshot
  allocated_storage_gb  = var.db_allocated_storage_gb
}

module "evidence" {
  count       = var.enable_evidence_bucket ? 1 : 0
  source      = "../../modules/evidence_bucket"
  name        = local.name
  environment = var.environment
}

module "cognito" {
  source              = "../../modules/cognito"
  name                = local.name
  environment         = var.environment
  deletion_protection = var.cognito_deletion_protection
}

module "ingress" {
  source                = "../../modules/ingress"
  name                  = local.name
  environment           = var.environment
  vpc_id                = module.network.vpc_id
  public_subnet_ids     = module.network.public_subnet_ids
  alb_security_group_id = module.network.alb_security_group_id
  root_domain           = var.root_domain
  api_hostname          = local.api_host
  create_hosted_zone    = var.create_hosted_zone
  hosted_zone_id        = var.hosted_zone_id
}

module "observability" {
  source                  = "../../modules/observability"
  name                    = local.name
  environment             = var.environment
  log_retention_days      = var.log_retention_days
  alert_email             = var.alert_email
  alb_arn_suffix          = module.ingress.alb_arn_suffix
  target_group_arn_suffix = module.ingress.target_group_arn_suffix
  db_instance_identifier  = module.database.instance_identifier
  ecs_cluster_name        = local.name
  api_service_name        = "${local.name}-api"
  worker_service_name     = "${local.name}-worker"
  api_desired_count       = var.api_desired_count
  worker_desired_count    = var.worker_desired_count
}

module "compute" {
  source                     = "../../modules/compute"
  name                       = local.name
  environment                = var.environment
  region                     = var.region
  image                      = local.image
  app_subnet_ids             = module.network.app_subnet_ids
  public_subnet_ids          = module.network.public_subnet_ids
  tasks_in_public_subnets    = var.tasks_in_public_subnets
  api_security_group_id      = module.network.api_security_group_id
  worker_security_group_id   = module.network.worker_security_group_id
  jobs_security_group_id     = module.network.jobs_security_group_id
  api_target_group_arn       = module.ingress.target_group_arn
  api_desired_count          = var.api_desired_count
  worker_desired_count       = var.worker_desired_count
  log_group_name             = module.observability.log_group_name
  secret_arns                = module.secrets.arns
  rds_master_secret_arn      = module.database.master_user_secret_arn
  database_host              = module.database.endpoint
  database_name              = module.database.database_name
  database_master_username   = module.database.master_username
  evidence_access_policy_arn = var.enable_evidence_bucket ? module.evidence[0].access_policy_arn : ""
  evidence_bucket_name       = var.enable_evidence_bucket ? module.evidence[0].bucket_name : ""
  public_config              = merge(local.derived_public_config, var.public_config)
  payments_mode              = var.payments_mode
  enable_retention_schedule  = var.enable_retention_schedule
}

module "portal_site" {
  source       = "../../modules/static_site"
  providers    = { aws = aws, aws.us_east_1 = aws.us_east_1 }
  name         = "${local.name}-portal"
  environment  = var.environment
  hostname     = local.portal_host
  zone_id      = module.ingress.zone_id
  spa_fallback = true
}

module "admin_site" {
  source       = "../../modules/static_site"
  providers    = { aws = aws, aws.us_east_1 = aws.us_east_1 }
  name         = "${local.name}-admin"
  environment  = var.environment
  hostname     = local.admin_host
  zone_id      = module.ingress.zone_id
  spa_fallback = true
}

# The customer-facing web surface: universal/app links, the payment bounce
# page, share-link resolution (docs/36 PA-05/LE-09) — static only; the
# native Customer App is never a web deployment.
module "web_site" {
  source       = "../../modules/static_site"
  providers    = { aws = aws, aws.us_east_1 = aws.us_east_1 }
  name         = "${local.name}-web"
  environment  = var.environment
  hostname     = local.web_host
  zone_id      = module.ingress.zone_id
  spa_fallback = false
}

module "github_oidc" {
  source                    = "../../modules/github_oidc"
  name                      = local.name
  environment               = var.environment
  github_repository         = var.github_repository
  ecr_repository_arn        = module.registry.repository_arn
  ecs_cluster_arn           = module.compute.cluster_arn
  ecs_service_arns          = ["arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:service/${local.name}/${local.name}-api", "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:service/${local.name}/${local.name}-worker"]
  task_definition_families  = [for k in ["api", "worker", "maintenance", "migrate"] : "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-${k}:*"]
  execution_role_arns       = values(module.compute.execution_role_arns)
  task_role_arns            = values(module.compute.task_role_arns)
  static_deploy_policy_arns = [module.portal_site.deploy_policy_arn, module.admin_site.deploy_policy_arn, module.web_site.deploy_policy_arn]
  log_group_arn             = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:${module.observability.log_group_name}"
  create_build_role         = var.create_build_role
}

# ---- outputs (non-secret; consumed by the pipeline and the frontends) --------

output "account_id" { value = data.aws_caller_identity.current.account_id }
output "api_url" { value = module.ingress.api_url }
output "portal_url" { value = module.portal_site.url }
output "admin_url" { value = module.admin_site.url }
output "web_url" { value = module.web_site.url }
output "ecr_repository_url" { value = module.registry.repository_url }
output "ecs_cluster" { value = module.compute.cluster_name }
output "task_definitions" { value = module.compute.task_definition_arns }
output "jobs_network" { value = module.compute.jobs_network }
output "cognito" {
  description = "EXPO_PUBLIC_COGNITO_ISSUER / VITE_COGNITO_ISSUER + client ids per surface (public values)."
  value       = { issuer = module.cognito.issuer, client_ids = module.cognito.client_ids }
}
output "frontend_build_env" {
  description = "Build-time public configuration for the three frontends (no secrets)."
  value = {
    customer_app = { EXPO_PUBLIC_API_URL = module.ingress.api_url, EXPO_PUBLIC_COGNITO_ISSUER = module.cognito.issuer, EXPO_PUBLIC_COGNITO_CLIENT_ID = module.cognito.client_ids["mobile"] }
    portal       = { VITE_API_BASE_URL = module.ingress.api_url, VITE_COGNITO_ISSUER = module.cognito.issuer, VITE_COGNITO_CLIENT_ID = module.cognito.client_ids["portal"], VITE_PORTAL_AUTH_MODE = "live" }
    admin        = { VITE_API_BASE_URL = module.ingress.api_url, VITE_COGNITO_ISSUER = module.cognito.issuer, VITE_COGNITO_CLIENT_ID = module.cognito.client_ids["admin"], VITE_ADMIN_AUTH_MODE = "live" }
  }
}
output "static_sites" {
  value = {
    portal = { bucket = module.portal_site.bucket_name, distribution_id = module.portal_site.distribution_id }
    admin  = { bucket = module.admin_site.bucket_name, distribution_id = module.admin_site.distribution_id }
    web    = { bucket = module.web_site.bucket_name, distribution_id = module.web_site.distribution_id }
  }
}
output "github_roles" { value = { build = module.github_oidc.build_role_arn, deploy = module.github_oidc.deploy_role_arn } }
output "secrets" {
  description = "Secret ARNs whose VALUES the operator must supply (see infra/README.md §secrets)."
  value       = module.secrets.arns
}
output "rds_master_secret_arn" { value = module.database.master_user_secret_arn }
output "alerts_topic_arn" { value = module.observability.alerts_topic_arn }
output "evidence_bucket" { value = var.enable_evidence_bucket ? module.evidence[0].bucket_name : "" }
