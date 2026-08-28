# Netlify 部署说明

本项目的公开手机知识库可部署为 Netlify 静态站点和 Serverless Function；已发布知识卡片、待审卡片及版本记录保存在 Netlify Blobs 中。

## 首次部署

1. 将本项目上传至 GitHub 或 GitLab 仓库。
2. 在 Netlify 选择 **Add new project**，连接该仓库。
3. 保持构建设置为：Build command 留空、Publish directory 为 `public`、Functions directory 为 `netlify/functions`。仓库内的 `netlify.toml` 已配置这些值。
4. 在 Netlify 的 **Project configuration → Environment variables** 新增：

   - `NETLIFY_TAXKB_ADMIN_TOKEN`：一段自行生成的高强度随机字符串，用于管理知识卡片接口；不要写入代码或提交到仓库。

5. 点击 Deploy。首次访问 `/api/knowledge/*` 时，系统会在 Netlify Blobs 自动写入首批已审核知识卡片。

发布完成后，Netlify 会分配 `https://你的站点.netlify.app` 地址；在 Domain management 中可再绑定自己的域名。

## 管理接口

Netlify 版本的管理员接口需要请求头：

```text
Authorization: Bearer <NETLIFY_TAXKB_ADMIN_TOKEN>
```

支持的接口为：

- `GET /api/admin/knowledge-cards`
- `GET/POST /api/admin/knowledge-card-candidates`
- `POST /api/admin/knowledge-card-candidates/:id/review`
- `POST /api/admin/knowledge-cards/:id/rollback`

原本机版的法规采集、成员登录和定时扫描依赖常驻 Node 进程与本地文件，继续保留在本机版；它们没有部署进当前 Netlify Function。
