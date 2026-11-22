<?php
/**
 * Blog posts.
 *
 * @package Mansu_Rose
 */

defined( 'ABSPATH' ) || exit;
get_header();
?>
<main id="main" class="page-main">
	<?php
	while ( have_posts() ) :
		the_post();
		?>
		<article <?php post_class( 'wrap prose' ); ?>>
			<header class="shop-head"><div class="rule" aria-hidden="true"></div><h1 class="page-title"><?php the_title(); ?></h1><p class="eyebrow"><time datetime="<?php echo esc_attr( get_the_date( 'c' ) ); ?>"><?php echo esc_html( get_the_date() ); ?></time></p></header>
			<?php
			if ( has_post_thumbnail() ) {
				the_post_thumbnail( 'large', array( 'class' => 'lead-img' ) );
			}
			the_content();
			wp_link_pages();
			?>
		</article>
		<?php
		if ( comments_open() || get_comments_number() ) {
			echo '<div class="wrap prose">';
			comments_template();
			echo '</div>';
		}
	endwhile;
	?>
</main>
<?php
get_footer();
