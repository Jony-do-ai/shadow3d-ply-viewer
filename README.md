1. 安装 Node.js
去装 Node.js LTS 版本。
现在官方页面显示的 LTS 是 Node.js 24.15.0，Latest Release 是 25.9.0。做项目建议装 LTS，不要装 Latest Release。
装完后，在终端检查：
node -v
npm -v
2. 安装依赖
npm install
3. 直接用 PyCharm 的 Run Configuration 启动，推荐
在 PyCharm 上方菜单：
Run
→ Edit Configurations...
然后点左上角：
+
→ npm
配置成这样：
Name: dev
package.json: D:\shadow3d-ply-viewer\package.json
Command: run
Scripts: dev
Node interpreter: 你配置好的 node.exe
Package manager: nodejs安装目录\npm.cmd