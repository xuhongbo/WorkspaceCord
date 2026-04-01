# Discord Bot 配置指南

本文档将指导你创建并配置 Discord Bot，用于 WorkspaceCord。

---

## 前置要求

- 一个 Discord 账号
- 一个 Discord 服务器（或有管理员权限的服务器）
- 已安装 WorkspaceCord CLI

---

## 1. 创建 Discord 应用

### 1.1 访问开发者门户

打开浏览器，访问 [Discord Developer Portal](https://discord.com/developers/applications)

### 1.2 创建新应用

1. 点击右上角的 **"New Application"** 按钮
2. 输入应用名称（例如：`WorkspaceCord Bot`）
3. 阅读并同意服务条款
4. 点击 **"Create"**

![创建应用](https://discord.com/assets/developers-applications.png)

---

## 2. 配置 Bot

### 2.1 创建 Bot 用户

1. 在左侧菜单中，点击 **"Bot"**
2. 点击 **"Add Bot"** 按钮
3. 确认创建

### 2.2 获取 Bot Token

1. 在 Bot 页面，找到 **"TOKEN"** 部分
2. 点击 **"Reset Token"** 按钮
3. 复制生成的 Token（⚠️ **重要**：Token 只显示一次，请妥善保存）

```
示例格式：MTk4NjIyNDgzNDcwOTY3NDUxMg.G8vKqh.xxx...
```

⚠️ **安全提示**：Token 相当于 Bot 的密码，切勿泄露或提交到公开仓库！

### 2.3 配置 Bot 权限

在 Bot 页面向下滚动，找到 **"Privileged Gateway Intents"** 部分，启用以下权限：

| Intent | 是否必需 | 说明 |
|--------|---------|------|
| ✅ **Presence Intent** | 否 | 获取用户在线状态 |
| ✅ **Server Members Intent** | 是 | 获取服务器成员信息 |
| ✅ **Message Content Intent** | 是 | 读取消息内容（必需） |

💡 **提示**：Message Content Intent 是必需的，否则 Bot 无法读取用户发送的消息。

---

## 3. 获取应用信息

### 3.1 获取 Application ID (Client ID)

1. 在左侧菜单中，点击 **"General Information"**
2. 找到 **"APPLICATION ID"** 字段
3. 点击 **"Copy"** 按钮复制

```
示例格式：1234567890123456789
```

### 3.2 获取 Server ID (Guild ID)

1. 打开 Discord 客户端
2. 进入 **用户设置** → **高级**
3. 启用 **"开发者模式"**
4. 右键点击你的服务器图标
5. 选择 **"复制服务器 ID"**

---

## 4. 邀请 Bot 到服务器

### 4.1 生成邀请链接

1. 在左侧菜单中，点击 **"OAuth2"** → **"URL Generator"**
2. 在 **"SCOPES"** 部分，勾选：
   - ✅ `bot`
   - ✅ `applications.commands`

3. 在 **"BOT PERMISSIONS"** 部分，勾选：
   - ✅ **Administrator**（管理员权限）

💡 **为什么需要管理员权限？**

WorkspaceCord 需要管理员权限来：
- 创建和管理频道（Category、TextChannel、Thread、Forum）
- 管理消息（发送、编辑、删除、固定）
- 管理 Slash Commands
- 读取服务器成员信息

### 4.2 邀请 Bot

1. 复制生成的 OAuth2 URL
2. 在浏览器中打开该链接
3. 选择你的服务器
4. 点击 **"授权"**
5. 完成人机验证

✅ 成功后，Bot 会出现在服务器成员列表中（离线状态）

---

## 5. 配置 WorkspaceCord

### 5.1 运行配置向导

```bash
workspacecord config setup
# 或使用短别名
wsc config setup
```

### 5.2 按提示输入信息

配置向导会引导你完成以下步骤：

1. **Bot Token**：粘贴在步骤 2.2 中复制的 Token
2. **Client ID**：粘贴在步骤 3.1 中复制的 Application ID
3. **Guild ID**：粘贴在步骤 3.2 中复制的 Server ID
4. **访问控制**：选择允许使用 Bot 的用户
   - 推荐选择 "Specific users"，然后输入你的 Discord User ID
   - 获取 User ID：右键点击你的用户名 → "复制用户 ID"

### 5.3 测试连接

配置向导会自动测试 Bot 连接，确保配置正确。

✅ 看到 "Connected" 消息表示配置成功！

---

## 6. 启动 Bot

### 6.1 前台运行（测试）

```bash
workspacecord
```

### 6.2 后台运行（推荐）

```bash
workspacecord daemon install
```

Bot 会作为系统服务运行，开机自启，崩溃自动重启。

---

## 7. 验证 Bot 是否正常工作

1. 在 Discord 中，Bot 应该显示为 **在线状态**（绿色圆点）
2. 在任意文本频道输入 `/`，应该能看到 Bot 的 Slash Commands
3. 尝试运行 `/project setup` 命令

✅ 如果能看到命令列表，说明 Bot 配置成功！

---

## 8. 常见问题 (FAQ)

### Q1: Bot 显示离线状态？

**可能原因：**
- ❌ Bot Token 配置错误
- ❌ WorkspaceCord 未启动
- ❌ 网络连接问题

**解决方法：**
```bash
# 检查配置
wsc config list

# 重新配置
wsc config setup

# 查看日志
wsc daemon status
```

---

### Q2: 看不到 Slash Commands？

**可能原因：**
- ❌ 未启用 `applications.commands` scope
- ❌ Guild ID 配置错误（命令注册到错误的服务器）
- ❌ Bot 缺少权限

**解决方法：**
1. 确认 OAuth2 URL 包含 `applications.commands`
2. 检查 Guild ID 是否正确：`wsc config get DISCORD_GUILD_ID`
3. 重新邀请 Bot 并授予管理员权限

---

### Q3: Bot 无法读取消息内容？

**可能原因：**
- ❌ 未启用 "Message Content Intent"

**解决方法：**
1. 返回 [Discord Developer Portal](https://discord.com/developers/applications)
2. 选择你的应用 → Bot
3. 启用 **"Message Content Intent"**
4. 重启 Bot：`wsc daemon install`（会自动重启）

---

### Q4: 提示 "Missing Permissions" 错误？

**可能原因：**
- ❌ Bot 缺少必要的权限

**解决方法：**
1. 确保 Bot 拥有 **Administrator** 权限
2. 或者手动授予以下权限：
   - Manage Channels
   - Manage Messages
   - Read Messages/View Channels
   - Send Messages
   - Create Public Threads
   - Manage Threads

---

### Q5: 如何获取 User ID？

**步骤：**
1. 打开 Discord 客户端
2. 进入 **用户设置** → **高级**
3. 启用 **"开发者模式"**
4. 右键点击你的用户名或头像
5. 选择 **"复制用户 ID"**

---

## 9. 配置文件位置

WorkspaceCord 的配置存储在：

- **配置文件**：`~/.config/workspacecord/config.json`
- **数据目录**：`~/.workspacecord/`

你可以手动编辑配置文件，或使用 CLI 命令：

```bash
# 查看所有配置
wsc config list

# 查看配置文件路径
wsc config path

# 修改配置
wsc config set <key> <value>
```

---

## 10. 参考资源

- [Discord Developer Portal](https://discord.com/developers/applications)
- [Discord Bot 权限计算器](https://discordapi.com/permissions.html)
- [WorkspaceCord GitHub](https://github.com/xuhongbo/WorkspaceCord)
- [WorkspaceCord 文档](../README.md)

---

## 需要帮助？

如果遇到问题，请：

1. 查看上面的 FAQ 部分
2. 检查 [GitHub Issues](https://github.com/xuhongbo/WorkspaceCord/issues)
3. 提交新的 Issue 描述你的问题

---

**祝你使用愉快！** 🎉
