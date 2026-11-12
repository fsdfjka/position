-- 泉州监控点位数据库初始化
-- MySQL 8.0+
-- 路口 19 条 / 相机 30 台

CREATE DATABASE IF NOT EXISTS `quanzhou_monitor`
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `quanzhou_monitor`;

DROP TABLE IF EXISTS `cameras`;
DROP TABLE IF EXISTS `intersections`;

CREATE TABLE `intersections` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`       VARCHAR(64)     NOT NULL COMMENT '业务唯一编号，对应前端 JSON 的 id',
  `name`       VARCHAR(128)    NOT NULL,
  `roads`      VARCHAR(256)    DEFAULT NULL,
  `lng`        DECIMAL(10,7)  NOT NULL,
  `lat`        DECIMAL(10,7)  NOT NULL,
  `origin`     TINYINT         NOT NULL DEFAULT 0 COMMENT '0=内置 1=手动新增',
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_code` (`code`),
  KEY `idx_location` (`lng`, `lat`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='监控路口';

CREATE TABLE `cameras` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `intersection_id` BIGINT UNSIGNED NOT NULL,
  `scene`           VARCHAR(255)    NOT NULL COMMENT '相机场景名',
  `type`            VARCHAR(16)     NOT NULL DEFAULT 'traffic',
  `bearing`         SMALLINT        NOT NULL DEFAULT 0 COMMENT '朝向角度，正北 0° 顺时针',
  `dir_label`       VARCHAR(8)      NOT NULL DEFAULT '北向',
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_intersection` (`intersection_id`),
  CONSTRAINT `fk_camera_intersection`
    FOREIGN KEY (`intersection_id`) REFERENCES `intersections` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='路口监控相机';

-- 种子数据
INSERT INTO `intersections` (`id`, `code`, `name`, `roads`, `lng`, `lat`, `origin`) VALUES
(1, '泉秀刺桐', '泉秀刺桐', '泉秀街 × 刺桐路', 118.6008400, 24.8901400, 0),
(2, '刺桐津淮', '刺桐津淮', '刺桐路 × 津淮街', 118.6034200, 24.8969100, 0),
(3, '刺桐丰泽', '刺桐丰泽', '刺桐路 × 丰泽街', 118.6063600, 24.9046900, 0),
(4, '刺桐湖心', '刺桐湖心', '刺桐路 × 湖心街', 118.6078700, 24.9087000, 0),
(5, '刺桐东湖', '刺桐东湖', '刺桐路 × 东湖街', 118.6097200, 24.9134100, 0),
(6, '田安东湖', '田安东湖', '田安路 × 东湖街', 118.6047600, 24.9141400, 0),
(7, '田安湖心', '田安湖心', '田安路 × 湖心街', 118.6033000, 24.9089700, 0),
(8, '田安丰泽', '田安丰泽', '田安路 × 丰泽街', 118.6013800, 24.9056200, 0),
(9, '田安津淮', '田安津淮', '田安路 × 津淮街', 118.5975600, 24.8989500, 0),
(10, '田安泉秀', '田安泉秀', '田安路 × 泉秀街', 118.5945500, 24.8938100, 0),
(11, '温陵泉秀', '温陵泉秀', '温陵路 × 泉秀街', 118.5898700, 24.8979000, 0),
(12, '温陵津淮', '温陵津淮', '温陵路 × 津淮街', 118.5921100, 24.9022100, 0),
(13, '温陵丰泽', '温陵丰泽', '温陵路 × 丰泽街', 118.5946600, 24.9071300, 0),
(14, '东街南俊', '东街南俊', '东街 × 南俊路', 118.5909400, 24.9144400, 0),
(15, '打锡南俊', '打锡南俊', '打锡街 × 南俊路', 118.5879300, 24.9090500, 0),
(16, '涂门百源', '涂门百源', '涂门街 × 百源路', 118.5885200, 24.9041600, 0),
(17, '中山打锡', '中山打锡', '中山路 × 打锡街', 118.5849200, 24.9097400, 0),
(18, '钟楼岗', '钟楼岗', '东街 × 中山路', 118.5865500, 24.9152200, 0),
(19, '新门新华', '新门新华', '新门街 × 新华路', 118.5783900, 24.9122700, 0);

INSERT INTO `cameras` (`id`, `intersection_id`, `scene`, `type`, `bearing`, `dir_label`) VALUES
(1, 1, '泉秀街刺桐路交通', 'traffic', 90, '东向'),
(2, 1, '刺桐路悦华酒店联动快球', 'ptz', 90, '东向'),
(3, 1, '泉秀街悦华酒店联动快球', 'ptz', 0, '北向'),
(4, 2, '津淮街国际华城联动快球', 'ptz', 180, '南向'),
(5, 3, '刺桐路丰泽街交通', 'traffic', 180, '南向'),
(6, 3, '丰泽街湖心花园城联动快球', 'ptz', 0, '北向'),
(7, 3, '刺桐路福新花园城联动快球', 'ptz', 270, '西向'),
(8, 4, '刺桐路辉庆广场联动快球', 'ptz', 90, '东向'),
(9, 4, '刺桐路湖心街交通', 'traffic', 270, '西向'),
(10, 5, '东湖刺桐交通', 'traffic', 225, '西南向'),
(11, 6, '田安路东湖街交通', 'traffic', 225, '西南向'),
(12, 6, '少林路御峰湖庭联动快球', 'ptz', 270, '西向'),
(13, 7, '田安路湖心街交通', 'traffic', 180, '南向'),
(14, 8, '丰泽街田安路交通', 'traffic', 270, '西向'),
(15, 8, '丰泽街明鑫中心小区联动快球', 'ptz', 0, '北向'),
(16, 8, '田安路南益广场联动快球', 'ptz', 225, '西南向'),
(17, 9, '田安路津淮街交通', 'traffic', 90, '东向'),
(18, 10, '田安泉秀路口球机', 'ptz', 180, '南向'),
(19, 10, '田安路丰华小区联动快球', 'ptz', 90, '东向'),
(20, 11, '泉秀路温陵路交通', 'traffic', 90, '东向'),
(21, 11, '泉秀温陵高空', 'ptz', 180, '南向'),
(22, 12, '津淮街温陵路交通', 'traffic', 270, '西向'),
(23, 13, '九一温陵东抓拍球机', 'ptz', 270, '西向'),
(24, 13, '温陵丰泽交通', 'traffic', 270, '西向'),
(25, 14, '东街南俊路交通', 'traffic', 270, '西向'),
(26, 15, '打锡南俊交通', 'traffic', 0, '北向'),
(27, 16, '涂门百源交通', 'traffic', 270, '西向'),
(28, 17, '打锡中山交通', 'traffic', 90, '东向'),
(29, 18, '东街中山交通', 'traffic', 180, '南向'),
(30, 19, '新华路新门街交通', 'traffic', 180, '南向');
