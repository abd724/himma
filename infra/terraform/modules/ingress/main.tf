# Himma — API ingress (docs/38 §8/§12): Application Load Balancer, ACM
# certificate (DNS-validated in Route 53), HTTP→HTTPS redirect, target group
# health on `/internal/ready`, deregistration delay aligned with the W6
# drain budget. DNS is parameterized on `root_domain`; the hosted zone is
# looked up (or created when `create_hosted_zone`) — domain OWNERSHIP and
# registrar delegation stay owner actions (docs/36 IN-03).

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" { type = string }
variable "environment" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "alb_security_group_id" { type = string }
variable "root_domain" {
  type        = string
  description = "Registrable domain the company controls (e.g. himma.app). Never assumed."
}
variable "api_hostname" {
  type        = string
  description = "FQDN for the API (e.g. api.himma.app or api.staging.himma.app)."
}
variable "create_hosted_zone" {
  type        = bool
  description = "Create the Route 53 public hosted zone for root_domain (the owner then delegates NS at the registrar). false = look it up."
  default     = false
}
variable "hosted_zone_id" {
  type        = string
  description = "Existing hosted zone id when create_hosted_zone = false and lookup by name is ambiguous."
  default     = ""
}
variable "drain_seconds" {
  type    = number
  default = 20
}
variable "access_logs_bucket" {
  type    = string
  default = ""
}
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  tags = merge(var.tags, { "himma:environment" = var.environment, "himma:component" = "ingress" })
}

resource "aws_route53_zone" "this" {
  count = var.create_hosted_zone ? 1 : 0
  name  = var.root_domain
  tags  = local.tags
}

data "aws_route53_zone" "this" {
  count        = var.create_hosted_zone ? 0 : 1
  zone_id      = var.hosted_zone_id != "" ? var.hosted_zone_id : null
  name         = var.hosted_zone_id == "" ? var.root_domain : null
  private_zone = false
}

locals {
  zone_id = var.create_hosted_zone ? aws_route53_zone.this[0].zone_id : data.aws_route53_zone.this[0].zone_id
}

resource "aws_acm_certificate" "api" {
  domain_name       = var.api_hostname
  validation_method = "DNS"
  tags              = local.tags
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "api_validation" {
  for_each = {
    for dvo in aws_acm_certificate.api.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }
  zone_id         = local.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for r in aws_route53_record.api_validation : r.fqdn]
}

resource "aws_lb" "api" {
  name                       = substr("${var.name}-api", 0, 32)
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [var.alb_security_group_id]
  subnets                    = var.public_subnet_ids
  drop_invalid_header_fields = true
  idle_timeout               = 60
  enable_deletion_protection = var.environment == "production"
  tags                       = local.tags

  dynamic "access_logs" {
    for_each = var.access_logs_bucket != "" ? [1] : []
    content {
      bucket  = var.access_logs_bucket
      prefix  = "alb/${var.name}"
      enabled = true
    }
  }
}

resource "aws_lb_target_group" "api" {
  name                 = substr("${var.name}-api", 0, 32)
  port                 = 8080
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = var.drain_seconds
  tags                 = local.tags

  health_check {
    path                = "/internal/ready" # DB probe + identity + migration head + drain flag (docs/37 §7)
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.api.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_route53_record" "api" {
  zone_id = local.zone_id
  name    = var.api_hostname
  type    = "A"
  alias {
    name                   = aws_lb.api.dns_name
    zone_id                = aws_lb.api.zone_id
    evaluate_target_health = true
  }
}

output "zone_id" { value = local.zone_id }
output "alb_arn" { value = aws_lb.api.arn }
output "alb_arn_suffix" { value = aws_lb.api.arn_suffix }
output "alb_dns_name" { value = aws_lb.api.dns_name }
output "target_group_arn" { value = aws_lb_target_group.api.arn }
output "target_group_arn_suffix" { value = aws_lb_target_group.api.arn_suffix }
output "api_url" { value = "https://${var.api_hostname}" }
