# .ether 结构

`.ether/` 是一个 Einzbern 项目的库。工单、纪要、项目知识、配置记录与大文件都保存在这里。库可以位于项目内，也可以放在云同步目录；由设备注册表把项目指向它。

## 库根目录

新库的根目录固定有七项：

```text
.ether/
├── manifest.json
├── akasha/
├── crest/
├── config/
├── artifacts/
├── README.md
└── .gitignore
```

| 路径 | 用途 |
| --- | --- |
| `manifest.json` | 库 id、格式版本、最低引擎版本和项目提示。 |
| `akasha/` | 按设备分开的只追加事件流；记录真值所在之处。 |
| `crest/` | 项目级知识卡与文章。 |
| `config/project.json` | 项目级设置和配置记录的可读投影。 |
| `artifacts/` | 按内容摘要存放的大文件。 |
| `README.md` | 名称说明和旧名对照。 |
| `.gitignore` | 内容为 `*`，让 Git 不把嵌在项目仓库里的库当成项目源码。 |

这些文件由引擎管理，不要手工编辑。`config/` 是方便其他读取者查看的投影，事件才是配置真值；知识、索引与快照也不要从缓存目录手工恢复。

## 事件流与每台设备的文件

每台设备只向自己的 `akasha/<device-id>/` 追加事件。设备目录中有自己的流清单与编号事件段；其他设备不会同时改写这一组文件。同步完成后，引擎读取所有设备目录并合并事件，生成当前设备可以直接读取的视图。

库根 `manifest.json` 记录库级信息；每条设备流也有自己的清单，说明该设备已提交的事件段、流头和写入它的引擎版本。清单和事件段由引擎写入，修改它们会破坏读取校验。

## 配置记录投影

`config/project.json` 显示从事件重建的项目设置和配置记录。配置记录包含四类：`managed-section`、`rule`、`variable` 与 `gate`。更改配置时，引擎先把事件追加到本机流，再更新投影；投影不是可编辑的数据源。

## 知识与本机缓存

项目知识保存在 `.ether/crest/`，随项目库同步。每位用户自己的知识库也使用 `crest` 这个名字，但缺省保存在本机设备目录中；它不会随项目库同步，可以在设备级 `crest.userPath` 中指定别处。

设备目录 `~/.einzbern/` 保存该机身份、库注册信息、本机设置、锁、备份、已安装引擎版本，以及按库分开的 `cache/`。缓存里有重放后的视图、索引、快照和门结果；它只服务本机，可以从同步来的事件流重建，不属于库，也不会上传到云端。

## Coordination and concrete projects

Cross Project is an explicitly declared coordination chain. Each concrete
project chain owns its development configuration. Names and directories never
identify a chain's role. Stable `{libraryId, projectId}` references identify
involved projects; this device's registry locates them. When this device has
no coordination library, setup creates one in the device directory
(`coordination-library`); another device finds it by its identity, never by that
path. See the project-chain sections of the configuration and compatibility
specifications.
