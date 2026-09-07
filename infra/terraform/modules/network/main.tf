# Himma — network module (docs/38 §8/§17): one VPC, two AZs, public ingress
# subnets (ALB, NAT), private application subnets (ECS tasks), isolated
# database subnets (RDS — no route to the internet at all), deliberate egress.
#
# Egress model: application tasks reach Stripe/Cognito over HTTPS through NAT
# (production: one NAT per AZ; staging: one NAT, or none when tasks are placed
# in public subnets with public IPs — `tasks_in_public_subnets`). AWS-native
# dependencies (S3, ECR, Secrets Manager, CloudWatch Logs) can use VPC
# endpoints so that traffic never leaves the VPC and NAT data charges shrink.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "name" { type = string }
variable "environment" { type = string }
variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}
variable "azs" {
  type        = list(string)
  description = "Exactly two availability zones in the region (e.g. me-central-1a, me-central-1b)."
  validation {
    condition     = length(var.azs) == 2
    error_message = "Provide exactly two availability zones."
  }
}
variable "nat_gateway_count" {
  type        = number
  description = "0 (staging with public tasks), 1 (staging), or 2 (production: one per AZ)."
  default     = 1
  validation {
    condition     = contains([0, 1, 2], var.nat_gateway_count)
    error_message = "nat_gateway_count must be 0, 1 or 2."
  }
}
variable "enable_interface_endpoints" {
  type        = bool
  description = "ECR (api+dkr), Secrets Manager, CloudWatch Logs interface endpoints (private, no NAT data charges)."
  default     = true
}
variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  tags           = merge(var.tags, { "himma:environment" = var.environment, "himma:component" = "network" })
  public_cidrs   = [cidrsubnet(var.vpc_cidr, 8, 0), cidrsubnet(var.vpc_cidr, 8, 1)]
  app_cidrs      = [cidrsubnet(var.vpc_cidr, 8, 10), cidrsubnet(var.vpc_cidr, 8, 11)]
  database_cidrs = [cidrsubnet(var.vpc_cidr, 8, 20), cidrsubnet(var.vpc_cidr, 8, 21)]
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${var.name}-vpc" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-igw" })
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_cidrs[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${var.name}-public-${var.azs[count.index]}", "himma:tier" = "public" })
}

resource "aws_subnet" "app" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.app_cidrs[count.index]
  availability_zone = var.azs[count.index]
  tags              = merge(local.tags, { Name = "${var.name}-app-${var.azs[count.index]}", "himma:tier" = "app" })
}

resource "aws_subnet" "database" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.database_cidrs[count.index]
  availability_zone = var.azs[count.index]
  tags              = merge(local.tags, { Name = "${var.name}-db-${var.azs[count.index]}", "himma:tier" = "database" })
}

resource "aws_eip" "nat" {
  count  = var.nat_gateway_count
  domain = "vpc"
  tags   = merge(local.tags, { Name = "${var.name}-nat-${count.index}" })
}

resource "aws_nat_gateway" "this" {
  count         = var.nat_gateway_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = merge(local.tags, { Name = "${var.name}-nat-${count.index}" })
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-rt-public" })
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One route table per app subnet so each AZ can use its own NAT (production).
resource "aws_route_table" "app" {
  count  = 2
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-rt-app-${var.azs[count.index]}" })
}

resource "aws_route" "app_nat" {
  count                  = var.nat_gateway_count > 0 ? 2 : 0
  route_table_id         = aws_route_table.app[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[min(count.index, var.nat_gateway_count - 1)].id
}

resource "aws_route_table_association" "app" {
  count          = 2
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[count.index].id
}

# Database subnets: a route table with NO default route — RDS is unreachable
# from and to the internet by construction.
resource "aws_route_table" "database" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-rt-database" })
}

resource "aws_route_table_association" "database" {
  count          = 2
  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.database.id
}

# ---- security groups -------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "Public HTTPS ingress to the API load balancer"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_http_redirect" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP, redirected to HTTPS by the listener"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_security_group" "api" {
  name        = "${var.name}-api"
  description = "API tasks: ingress only from the ALB"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-api" })
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  description                  = "API port from the ALB only"
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "ALB to API tasks"
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
}

resource "aws_security_group" "worker" {
  name        = "${var.name}-worker"
  description = "Worker tasks: NO ingress (no public listener); egress only"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-worker" })
}

resource "aws_security_group" "jobs" {
  name        = "${var.name}-jobs"
  description = "Short-lived maintenance/migration tasks: NO ingress; egress only"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-jobs" })
}

# Application egress: HTTPS to the internet (Stripe, Cognito) + PostgreSQL to the DB SG.
resource "aws_vpc_security_group_egress_rule" "app_https" {
  for_each          = { api = aws_security_group.api.id, worker = aws_security_group.worker.id, jobs = aws_security_group.jobs.id }
  security_group_id = each.value
  description       = "HTTPS egress (Stripe, Cognito, AWS APIs)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_security_group" "database" {
  name        = "${var.name}-database"
  description = "RDS: PostgreSQL only from api/worker/jobs security groups"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-database" })
}

resource "aws_vpc_security_group_ingress_rule" "database_from_app" {
  for_each                     = { api = aws_security_group.api.id, worker = aws_security_group.worker.id, jobs = aws_security_group.jobs.id }
  security_group_id            = aws_security_group.database.id
  description                  = "PostgreSQL from ${each.key}"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_vpc_security_group_egress_rule" "app_to_database" {
  for_each                     = { api = aws_security_group.api.id, worker = aws_security_group.worker.id, jobs = aws_security_group.jobs.id }
  security_group_id            = each.value
  description                  = "PostgreSQL to RDS"
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

# ---- VPC endpoints (private AWS-service access; no NAT data charges) --------

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.app[*].id, [aws_route_table.database.id])
  tags              = merge(local.tags, { Name = "${var.name}-vpce-s3" })
}

data "aws_region" "current" {}

resource "aws_security_group" "endpoints" {
  count       = var.enable_interface_endpoints ? 1 : 0
  name        = "${var.name}-vpce"
  description = "Interface endpoints: HTTPS from application subnets"
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-vpce" })
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  count             = var.enable_interface_endpoints ? 1 : 0
  security_group_id = aws_security_group.endpoints[0].id
  description       = "HTTPS from the VPC"
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = var.enable_interface_endpoints ? toset(["ecr.api", "ecr.dkr", "secretsmanager", "logs"]) : toset([])
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.app[*].id
  security_group_ids  = [aws_security_group.endpoints[0].id]
  private_dns_enabled = true
  tags                = merge(local.tags, { Name = "${var.name}-vpce-${each.value}" })
}

output "vpc_id" { value = aws_vpc.this.id }
output "vpc_cidr" { value = aws_vpc.this.cidr_block }
output "public_subnet_ids" { value = aws_subnet.public[*].id }
output "app_subnet_ids" { value = aws_subnet.app[*].id }
output "database_subnet_ids" { value = aws_subnet.database[*].id }
output "alb_security_group_id" { value = aws_security_group.alb.id }
output "api_security_group_id" { value = aws_security_group.api.id }
output "worker_security_group_id" { value = aws_security_group.worker.id }
output "jobs_security_group_id" { value = aws_security_group.jobs.id }
output "database_security_group_id" { value = aws_security_group.database.id }
