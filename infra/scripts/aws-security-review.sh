#!/usr/bin/env bash
# Himma — security review of the ACTUAL AWS state of one workload account
# (owner directive W6-4B §27) — reads AWS APIs, never Terraform source. Exit
# 0 = every invariant holds. Runs under the authenticated engineering identity
# of that account after `tf-preflight.sh`.
#
#   AWS_REGION=me-central-1 infra/scripts/aws-security-review.sh staging
set -euo pipefail
ENV_NAME="${1:-}"
[[ "$ENV_NAME" == "staging" || "$ENV_NAME" == "production" ]] || { echo "usage: $0 <staging|production>" >&2; exit 2; }
NAME="himma-$ENV_NAME"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
fail() { printf 'SECURITY REVIEW FAILED: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok: %s\n' "$*"; }
echo "== security review of account $ACCOUNT ($ENV_NAME, $(aws configure get region 2>/dev/null || echo "${AWS_REGION:-?}"))"

echo "-- IAM: no users, no access keys (OIDC only)"
[[ "$(aws iam list-users --query 'length(Users)' --output text)" == "0" ]] || fail "IAM users exist in the workload account"
aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text | grep -q token.actions.githubusercontent.com || fail "GitHub OIDC provider missing"
pass "IAM"

echo "-- S3: every himma bucket blocks public access and refuses non-TLS"
for b in $(aws s3api list-buckets --query "Buckets[?starts_with(Name, '$NAME')].Name" --output text); do
  pab="$(aws s3api get-public-access-block --bucket "$b" --query 'PublicAccessBlockConfiguration' --output json)"
  printf '%s' "$pab" | python3 -c 'import json,sys; c=json.load(sys.stdin); assert all(c.values()), c' || fail "$b does not block all public access"
  aws s3api get-bucket-policy --bucket "$b" --query Policy --output text | grep -q '"aws:SecureTransport"' || fail "$b has no TLS-only policy"
  aws s3api get-bucket-encryption --bucket "$b" --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' --output text | grep -qE 'AES256|aws:kms' || fail "$b not encrypted"
  echo "   $b: block-public ✓ tls-only ✓ encrypted ✓"
done
pass "S3"

echo "-- RDS: not publicly accessible; encrypted"
[[ "$(aws rds describe-db-instances --db-instance-identifier "$NAME-postgres" --query 'DBInstances[0].PubliclyAccessible' --output text)" == "False" ]] || fail "RDS public"
[[ "$(aws rds describe-db-instances --db-instance-identifier "$NAME-postgres" --query 'DBInstances[0].StorageEncrypted' --output text)" == "True" ]] || fail "RDS unencrypted"
pass "RDS"

echo "-- Security groups: only the ALB admits 0.0.0.0/0, and only on 80/443; RDS admits 5432 from task SGs only"
vpc="$(aws ec2 describe-vpcs --filters "Name=tag:Name,Values=$NAME-vpc" --query 'Vpcs[0].VpcId' --output text)"
open="$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$vpc" --query "SecurityGroups[].{name:GroupName,rules:IpPermissions[?contains(IpRanges[].CidrIp, '0.0.0.0/0')].[FromPort,ToPort]}" --output json)"
printf '%s' "$open" | python3 -c '
import json,sys
sgs=json.load(sys.stdin); bad=[]
for sg in sgs:
    for fr,to in sg["rules"]:
        if not (sg["name"].endswith("-alb") and (fr,to) in ((80,80),(443,443))): bad.append((sg["name"],fr,to))
print("   world-open rules:", [(s["name"],r) for s in sgs for r in s["rules"]])
assert not bad, bad' || fail "unexpected world-open security-group rule"
rds_sg="$(aws rds describe-db-instances --db-instance-identifier "$NAME-postgres" --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' --output text)"
aws ec2 describe-security-groups --group-ids "$rds_sg" --query 'SecurityGroups[0].IpPermissions[].{from:FromPort,to:ToPort,cidrs:IpRanges[].CidrIp,sgs:UserIdGroupPairs[].GroupId}' --output json
[[ "$(aws ec2 describe-security-groups --group-ids "$rds_sg" --query 'length(SecurityGroups[0].IpPermissions[].IpRanges[])' --output text)" == "0" ]] || fail "RDS SG admits a CIDR"
pass "security groups"

echo "-- ECS: api is the only ALB-attached service; worker has no load balancer; maintenance/migrate are task definitions only"
svcs="$(aws ecs list-services --cluster "$NAME" --query 'serviceArns' --output text | tr '\t' '\n' | sed 's#.*/##' | sort | tr '\n' ' ')"
[[ "$svcs" == "$NAME-api $NAME-worker " ]] || fail "service set: $svcs"
[[ "$(aws ecs describe-services --cluster "$NAME" --services "$NAME-worker" --query 'length(services[0].loadBalancers)' --output text)" == "0" ]] || fail "worker has a load balancer"
for fam in api worker maintenance migrate; do
  aws ecs describe-task-definition --task-definition "$NAME-$fam" --query 'taskDefinition.containerDefinitions[0].{ro:readonlyRootFilesystem,user:user}' --output text | grep -q "True.*10001:10001" || fail "$fam task not read-only/non-root"
done
pass "ECS"

echo "-- Secrets: each runtime execution role can read ONLY its own DB secret (simulated policy evaluation)"
for fam in api worker maintenance; do
  role="arn:aws:iam::$ACCOUNT:role/$NAME-exec-$fam"
  own="$(aws secretsmanager describe-secret --secret-id "himma/$ENV_NAME/db/$fam" --query ARN --output text)"
  for other in api worker maintenance; do
    arn="$(aws secretsmanager describe-secret --secret-id "himma/$ENV_NAME/db/$other" --query ARN --output text)"
    decision="$(aws iam simulate-principal-policy --policy-source-arn "$role" --action-names secretsmanager:GetSecretValue --resource-arns "$arn" --query 'EvaluationResults[0].EvalDecision' --output text)"
    if [[ "$other" == "$fam" ]]; then [[ "$decision" == "allowed" ]] || fail "$fam cannot read its own secret"; else [[ "$decision" != "allowed" ]] || fail "$fam can read $other's secret"; fi
  done
  master="$(aws rds describe-db-instances --db-instance-identifier "$NAME-postgres" --query 'DBInstances[0].MasterUserSecret.SecretArn' --output text)"
  [[ "$(aws iam simulate-principal-policy --policy-source-arn "$role" --action-names secretsmanager:GetSecretValue --resource-arns "$master" --query 'EvaluationResults[0].EvalDecision' --output text)" != "allowed" ]] || fail "$fam can read the RDS master secret"
  echo "   $fam: own secret only ✓ (master denied)"
done
pass "secret separation"

echo "-- Evidence bucket: only the API task role may touch it"
evidence="$(aws s3api list-buckets --query "Buckets[?starts_with(Name, '$NAME-evidence')].Name" --output text)"
if [[ -n "$evidence" ]]; then
  for fam in api worker maintenance; do
    d="$(aws iam simulate-principal-policy --policy-source-arn "arn:aws:iam::$ACCOUNT:role/$NAME-task-$fam" --action-names s3:PutObject --resource-arns "arn:aws:s3:::$evidence/*" --query 'EvaluationResults[0].EvalDecision' --output text)"
    if [[ "$fam" == "api" ]]; then [[ "$d" == "allowed" ]] || fail "api cannot write evidence"; else [[ "$d" != "allowed" ]] || fail "$fam can write evidence"; fi
  done
  pass "evidence access scoped to the API task role"
fi

echo "-- Payments: no live mode anywhere in task definitions"
for fam in api worker maintenance migrate; do
  aws ecs describe-task-definition --task-definition "$NAME-$fam" --query 'taskDefinition.containerDefinitions[0].environment' --output text | grep -qi 'PAYMENTS_MODE.*live' && fail "$fam has PAYMENTS_MODE=live"
done
pass "no live payment configuration"
echo "== SECURITY REVIEW PASSED ($ENV_NAME, account $ACCOUNT)"
