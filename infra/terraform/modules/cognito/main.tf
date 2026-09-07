# Himma — Cognito User Pool foundation (docs/26 D1 contract; docs/36
# ID-01/ID-02; docs/38 §2.9). ONE pool per environment (staging and
# production auth state are physically separate), three PUBLIC app clients
# matching the existing integration contract:
#   mobile  — the Customer App calls InitiateAuth (USER_PASSWORD_AUTH /
#             REFRESH_TOKEN_AUTH) and SignUp directly (no client secret);
#   portal  — the Provider Portal (server-mediated refresh; COGNITO_REFRESH_CLIENT_ID);
#   admin   — the Admin Portal.
# TOTP (SOFTWARE_TOKEN_MFA) is enabled as OPTIONAL at the pool level — the
# application enforces MFA for provider/admin principals itself (docs/26
# §5, B2-6C). No hosted UI, no social identity providers here: Apple/Google
# federation needs externally owned credentials (docs/36 ID-05…07) and is
# left as an explicit follow-up variable set, never fabricated.
#
# Nothing here invents authentication behavior: every setting mirrors the
# certified adapter/gateway expectations (issuer + client ids + refresh
# client + JWKS at <issuer>/.well-known/jwks.json).

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" { type = string }
variable "environment" { type = string }
variable "deletion_protection" {
  type    = bool
  default = true
}
variable "portal_callback_urls" {
  type        = list(string)
  description = "Not used by the direct-API flows; kept empty unless a hosted flow is ever approved."
  default     = []
}
variable "tags" {
  type    = map(string)
  default = {}
}

data "aws_region" "current" {}

resource "aws_cognito_user_pool" "this" {
  name                = "${var.name}-users"
  deletion_protection = var.deletion_protection ? "ACTIVE" : "INACTIVE"
  tags                = merge(var.tags, { "himma:environment" = var.environment, "himma:component" = "cognito" })

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  user_pool_add_ons {
    advanced_security_mode = "AUDIT"
  }

  schema {
    name                     = "email"
    attribute_data_type      = "String"
    required                 = true
    mutable                  = true
    developer_only_attribute = false
    string_attribute_constraints {
      min_length = 3
      max_length = 320
    }
  }

  lifecycle {
    ignore_changes = [schema] # Cognito normalizes schema after creation
  }
}

locals {
  clients = {
    mobile = { refresh_days = 30, name = "customer-app" }
    portal = { refresh_days = 7, name = "provider-portal" }
    admin  = { refresh_days = 1, name = "admin-portal" }
  }
}

resource "aws_cognito_user_pool_client" "this" {
  for_each     = local.clients
  name         = "${var.name}-${each.value.name}"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false # public clients (mobile app / browser SPAs)
  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 15
  id_token_validity      = 15
  refresh_token_validity = each.value.refresh_days
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  read_attributes  = ["email", "email_verified"]
  write_attributes = ["email"]
}

output "user_pool_id" { value = aws_cognito_user_pool.this.id }
output "user_pool_arn" { value = aws_cognito_user_pool.this.arn }
output "issuer" {
  description = "COGNITO_ISSUER / EXPO_PUBLIC_COGNITO_ISSUER / VITE_COGNITO_ISSUER"
  value       = "https://cognito-idp.${data.aws_region.current.region}.amazonaws.com/${aws_cognito_user_pool.this.id}"
}
output "client_ids" {
  description = "mobile → EXPO_PUBLIC_COGNITO_CLIENT_ID; portal → VITE_COGNITO_CLIENT_ID (portal) + COGNITO_REFRESH_CLIENT_ID; admin → VITE_COGNITO_CLIENT_ID (admin). COGNITO_CLIENT_IDS = all three."
  value       = { for k, c in aws_cognito_user_pool_client.this : k => c.id }
}
