# 自托管发布凭据

`upstream/scripts/publish-release.mjs` 只从 `ZCODE_RELEASE_SSH_PASS` 环境变量读取上传密钥；缺失时在实际上传前拒绝发布。`--dry-run` 不需要发布凭据。源码不再提供密码回退值；已有发布凭据的轮换和历史记录处置需另行执行，本次不接触线上账号或发布服务器。

本轮不执行发布脚本的真实上传；测试 `node --test scripts/tests/publishReleaseCredential.test.mjs` 和 `node --check scripts/publish-release.mjs`。回滚对应提交不恢复任何历史密码，若要回滚应保持环境注入规则。
